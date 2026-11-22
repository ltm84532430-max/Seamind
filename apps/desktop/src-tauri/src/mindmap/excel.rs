use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

const MAX_EXCEL_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EXCEL_XML_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EXCEL_ROWS_PER_SHEET: usize = 5_000;
const MAX_EXCEL_COLS_PER_SHEET: usize = 128;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedExcelSheet {
    pub name: String,
    pub row_count: usize,
    pub col_count: usize,
    pub truncated: bool,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedExcelWorkbook {
    pub file_name: String,
    pub file_path: String,
    pub format: String,
    pub sheets: Vec<ParsedExcelSheet>,
}

#[tauri::command]
pub async fn parse_excel_workbook(file_path: String) -> Result<ParsedExcelWorkbook, String> {
    tokio::task::spawn_blocking(move || parse_excel_workbook_sync(Path::new(&file_path)))
        .await
        .map_err(|error| format!("读取表格任务失败：{error}"))?
}

pub fn parse_excel_workbook_sync(path: &Path) -> Result<ParsedExcelWorkbook, String> {
    let trimmed_path = path.to_string_lossy().trim().to_string();
    if trimmed_path.is_empty() {
        return Err("请选择一个 Excel 或 CSV 表格文件。".to_string());
    }
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("无法访问表格文件：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是普通文件。".to_string());
    }
    if metadata.len() == 0 {
        return Err("表格文件为空。".to_string());
    }
    if metadata.len() > MAX_EXCEL_FILE_BYTES {
        return Err("表格文件超过 25 MB 上限，请拆分后导入。".to_string());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "spreadsheet".to_string());

    let sheets = match extension.as_str() {
        "xlsx" | "xlsm" => {
            let file =
                File::open(path).map_err(|error| format!("无法打开 Excel 文件：{error}"))?;
            parse_xlsx_reader(file)?
        }
        "csv" => {
            let bytes =
                std::fs::read(path).map_err(|error| format!("无法读取 CSV 文件：{error}"))?;
            vec![parse_delimited_bytes(&bytes, "Sheet1", None)]
        }
        "tsv" => {
            let bytes =
                std::fs::read(path).map_err(|error| format!("无法读取 TSV 文件：{error}"))?;
            vec![parse_delimited_bytes(&bytes, "Sheet1", Some(b'\t'))]
        }
        "xls" | "xlsb" => {
            return Err(
                "暂不支持老式二进制 .xls / .xlsb 格式，请先在 Excel 或 WPS 中另存为 .xlsx 或 .csv 后导入。"
                    .to_string(),
            );
        }
        _ => {
            return Err(
                "不支持的表格文件格式，仅支持 .xlsx、.xlsm、.csv 和 .tsv。".to_string(),
            );
        }
    };

    if sheets.is_empty() {
        return Err("表格文件中没有可读取的工作表。".to_string());
    }

    Ok(ParsedExcelWorkbook {
        file_name,
        file_path: trimmed_path,
        format: extension,
        sheets,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CellStyleKind {
    General,
    Date,
    DateTime,
    Time,
    Percent,
}

#[derive(Debug, Default)]
struct WorkbookStyles {
    xf_kinds: Vec<CellStyleKind>,
}

impl WorkbookStyles {
    fn kind_for(&self, style_index: Option<usize>) -> CellStyleKind {
        style_index
            .and_then(|index| self.xf_kinds.get(index).copied())
            .unwrap_or(CellStyleKind::General)
    }
}

fn read_zip_entry_text<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    target_path: &str,
) -> Result<Option<String>, String> {
    let normalized = target_path.trim_start_matches('/').replace('\\', "/");
    let matched_name = if archive.by_name(&normalized).is_ok() {
        Some(normalized)
    } else {
        (0..archive.len()).find_map(|index| {
            let file = archive.by_index(index).ok()?;
            let name = file.name().replace('\\', "/");
            if name.eq_ignore_ascii_case(&normalized) {
                Some(file.name().to_string())
            } else {
                None
            }
        })
    };

    let Some(entry_name) = matched_name else {
        return Ok(None);
    };

    let mut entry = archive
        .by_name(&entry_name)
        .map_err(|error| format!("读取工作簿内部文件 {entry_name} 失败：{error}"))?;
    if entry.size() > MAX_EXCEL_XML_ENTRY_BYTES {
        return Err(format!("工作表内容过大（{entry_name}），超出安全读取限制。"));
    }
    let mut bytes = Vec::new();
    entry
        .by_ref()
        .take(MAX_EXCEL_XML_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 {entry_name} 内容失败：{error}"))?;
    if bytes.len() as u64 > MAX_EXCEL_XML_ENTRY_BYTES {
        return Err(format!("工作表内容过大（{entry_name}），超出安全读取限制。"));
    }
    let text = String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string();
    Ok(Some(text))
}

fn attr_value<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attr| attr.name() == name)
        .map(|attr| attr.value())
}

fn resolve_xl_target(target: &str) -> String {
    let cleaned = target.trim().replace('\\', "/");
    if let Some(stripped) = cleaned.strip_prefix('/') {
        return stripped.to_string();
    }
    if cleaned.starts_with("xl/") {
        return cleaned;
    }
    format!("xl/{}", cleaned.trim_start_matches("./"))
}

fn parse_xlsx_reader<R: Read + std::io::Seek>(reader: R) -> Result<Vec<ParsedExcelSheet>, String> {
    let mut archive =
        ZipArchive::new(reader).map_err(|_| "文件不是有效的 .xlsx / .xlsm 工作簿。".to_string())?;

    let workbook_xml = read_zip_entry_text(&mut archive, "xl/workbook.xml")?
        .ok_or_else(|| "Excel 工作簿缺少 xl/workbook.xml。".to_string())?;
    let workbook_doc = roxmltree::Document::parse(&workbook_xml)
        .map_err(|error| format!("解析 workbook.xml 失败：{error}"))?;

    let date1904 = workbook_doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "workbookPr")
        .and_then(|node| attr_value(node, "date1904"))
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));

    let mut rel_targets: HashMap<String, String> = HashMap::new();
    if let Some(rels_xml) = read_zip_entry_text(&mut archive, "xl/_rels/workbook.xml.rels")? {
        if let Ok(rels_doc) = roxmltree::Document::parse(&rels_xml) {
            for node in rels_doc
                .descendants()
                .filter(|node| node.is_element() && node.tag_name().name() == "Relationship")
            {
                let Some(id) = attr_value(node, "Id") else {
                    continue;
                };
                let Some(target) = attr_value(node, "Target") else {
                    continue;
                };
                rel_targets.insert(id.to_string(), resolve_xl_target(target));
            }
        }
    }

    let mut sheet_entries: Vec<(String, String)> = Vec::new();
    let mut fallback_index = 1usize;
    for node in workbook_doc
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "sheet")
    {
        let name = attr_value(node, "name")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Sheet")
            .to_string();
        let rel_id = attr_value(node, "id").map(str::to_string);
        let sheet_path = rel_id
            .as_ref()
            .and_then(|id| rel_targets.get(id).cloned())
            .unwrap_or_else(|| format!("xl/worksheets/sheet{fallback_index}.xml"));
        fallback_index += 1;
        // Skip non-worksheet references (e.g. chartsheets without sheetData) gently if XML differs.
        if sheet_path.contains("chartsheets/") {
            continue;
        }
        sheet_entries.push((name, sheet_path));
    }

    if sheet_entries.is_empty() {
        return Err("Excel 工作簿中没有包含数据工作表。".to_string());
    }

    let shared_strings = match read_zip_entry_text(&mut archive, "xl/sharedStrings.xml")? {
        Some(xml) => parse_shared_strings(&xml),
        None => Vec::new(),
    };

    let styles = match read_zip_entry_text(&mut archive, "xl/styles.xml")? {
        Some(xml) => parse_styles(&xml),
        None => WorkbookStyles::default(),
    };

    let mut parsed_sheets = Vec::new();
    for (sheet_name, sheet_path) in sheet_entries {
        let Some(sheet_xml) = read_zip_entry_text(&mut archive, &sheet_path)? else {
            continue;
        };
        let sheet = parse_worksheet_xml(
            &sheet_name,
            &sheet_xml,
            &shared_strings,
            &styles,
            date1904,
        )?;
        parsed_sheets.push(sheet);
    }

    Ok(parsed_sheets)
}

fn collect_si_text(si_node: roxmltree::Node<'_, '_>) -> String {
    let mut out = String::new();
    for child in si_node.descendants() {
        if !child.is_element() || child.tag_name().name() != "t" {
            continue;
        }
        // Exclude phonetic ruby runs (<rPh><t>...</t></rPh>) attached to Japanese/CJK strings.
        if child
            .ancestors()
            .any(|ancestor| ancestor.is_element() && ancestor.tag_name().name() == "rPh")
        {
            continue;
        }
        if let Some(text) = child.text() {
            out.push_str(text);
        }
    }
    out
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    doc.descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "si")
        .map(collect_si_text)
        .collect()
}

fn classify_number_format(num_fmt_id: u32, format_code: Option<&str>) -> CellStyleKind {
    match num_fmt_id {
        14..=17 => return CellStyleKind::Date,
        18..=21 | 45..=47 => return CellStyleKind::Time,
        22 => return CellStyleKind::DateTime,
        9 | 10 => return CellStyleKind::Percent,
        _ => {}
    }

    let Some(raw_code) = format_code else {
        return CellStyleKind::General;
    };

    // Strip escaped characters, quoted literals, and bracket conditions like [Red], [$-409].
    let mut cleaned = String::with_capacity(raw_code.len());
    let mut chars = raw_code.chars().peekable();
    let mut in_quotes = false;
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let _ = chars.next();
            continue;
        }
        if ch == '"' {
            in_quotes = !in_quotes;
            continue;
        }
        if in_quotes {
            continue;
        }
        if ch == '[' {
            for bracket_ch in chars.by_ref() {
                if bracket_ch == ']' {
                    break;
                }
            }
            continue;
        }
        if ch == ';' {
            break;
        }
        cleaned.push(ch.to_ascii_lowercase());
    }

    if cleaned.contains('%') {
        return CellStyleKind::Percent;
    }

    let has_date_tokens =
        cleaned.contains('y') || cleaned.contains('d') || cleaned.contains("mmm");
    let has_time_tokens = cleaned.contains('h') || cleaned.contains('s');
    let has_date_separator = cleaned.contains('/') || cleaned.contains('-') || cleaned.contains('年') || cleaned.contains('月');

    if has_date_tokens && has_time_tokens {
        CellStyleKind::DateTime
    } else if has_date_tokens || (cleaned.contains('m') && has_date_separator && !cleaned.contains('0')) {
        CellStyleKind::Date
    } else if has_time_tokens && cleaned.contains(':') {
        CellStyleKind::Time
    } else {
        CellStyleKind::General
    }
}

fn parse_styles(xml: &str) -> WorkbookStyles {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return WorkbookStyles::default();
    };
    let mut custom_formats: HashMap<u32, String> = HashMap::new();
    for node in doc
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "numFmt")
    {
        if let (Some(id_str), Some(code)) = (
            attr_value(node, "numFmtId"),
            attr_value(node, "formatCode"),
        ) {
            if let Ok(id) = id_str.parse::<u32>() {
                custom_formats.insert(id, code.to_string());
            }
        }
    }

    let mut xf_kinds = Vec::new();
    if let Some(cell_xfs) = doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "cellXfs")
    {
        for xf in cell_xfs
            .children()
            .filter(|node| node.is_element() && node.tag_name().name() == "xf")
        {
            let num_fmt_id = attr_value(xf, "numFmtId")
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            let custom_code = custom_formats.get(&num_fmt_id).map(String::as_str);
            xf_kinds.push(classify_number_format(num_fmt_id, custom_code));
        }
    }

    WorkbookStyles { xf_kinds }
}

fn parse_cell_reference(reference: &str) -> Option<(usize, usize)> {
    let mut col: usize = 0;
    let mut row: usize = 0;
    let mut seen_col = false;
    let mut seen_row = false;

    for byte in reference.trim().bytes() {
        if byte.is_ascii_alphabetic() {
            if seen_row {
                return None;
            }
            seen_col = true;
            let digit = (byte.to_ascii_uppercase() - b'A') as usize + 1;
            col = col.checked_mul(26)?.checked_add(digit)?;
        } else if byte.is_ascii_digit() {
            seen_row = true;
            let digit = (byte - b'0') as usize;
            row = row.checked_mul(10)?.checked_add(digit)?;
        } else {
            return None;
        }
    }

    if seen_col && seen_row && col > 0 && row > 0 {
        Some((row - 1, col - 1))
    } else if seen_col && !seen_row && col > 0 {
        Some((0, col - 1))
    } else {
        None
    }
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, u32, u32) {
    // Howard Hinnant's Euclidean affine algorithm for proleptic Gregorian calendar dates.
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + i64::from(m <= 2);
    (year, m, d)
}

fn format_excel_serial_date(serial: f64, kind: CellStyleKind, date1904: bool) -> Option<String> {
    if !serial.is_finite() || serial < 0.0 || serial > 2_958_466.0 {
        return None;
    }
    let whole_days = serial.floor() as i64;
    let frac = serial - (whole_days as f64);
    let total_seconds = (frac * 86_400.0).round() as i64;
    let (extra_days, day_seconds) = if total_seconds >= 86_400 {
        (1, 0)
    } else {
        (0, total_seconds)
    };
    let adjusted_days = whole_days + extra_days;

    if kind == CellStyleKind::Time && adjusted_days == 0 {
        let hours = day_seconds / 3600;
        let minutes = (day_seconds % 3600) / 60;
        let seconds = day_seconds % 60;
        return Some(format!("{hours:02}:{minutes:02}:{seconds:02}"));
    }

    // Unix epoch (1970-01-01):
    // - 1900 date system: serial 25569 == 1970-01-01 (accounting for Excel's phantom 1900-02-29 at serial 60)
    // - 1904 date system: serial 24107 == 1970-01-01
    let unix_days = if date1904 {
        adjusted_days - 24_107
    } else if adjusted_days > 60 {
        adjusted_days - 25_569
    } else {
        adjusted_days - 25_568
    };
    let (year, month, day) = civil_from_days(unix_days);

    if kind == CellStyleKind::DateTime || (day_seconds > 0 && kind != CellStyleKind::Date) {
        let hours = day_seconds / 3600;
        let minutes = (day_seconds % 3600) / 60;
        Some(format!("{year:04}-{month:02}-{day:02} {hours:02}:{minutes:02}"))
    } else {
        Some(format!("{year:04}-{month:02}-{day:02}"))
    }
}

fn trim_float_text(raw: &str) -> String {
    if raw.eq_ignore_ascii_case("nan") || raw.eq_ignore_ascii_case("inf") {
        return raw.to_string();
    }
    if let Ok(num) = raw.parse::<f64>() {
        if !num.is_finite() {
            return raw.to_string();
        }
        if num == 0.0 {
            return "0".to_string();
        }
        // Preserve clean integers without trailing ".0", and reduce binary float noise (e.g. 12.300000000000001).
        if (num.fract()).abs() < 1e-12 && num.abs() < 9e15 {
            return format!("{:.0}", num);
        }
        let rounded = format!("{num:.10}");
        let trimmed = rounded.trim_end_matches('0').trim_end_matches('.');
        if trimmed == "-0" {
            return "0".to_string();
        }
        return trimmed.to_string();
    }
    raw.to_string()
}

fn format_numeric_value(raw: &str, style_kind: CellStyleKind, date1904: bool) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(num) = trimmed.parse::<f64>() else {
        return trimmed.to_string();
    };
    if !num.is_finite() {
        return trimmed.to_string();
    }
    match style_kind {
        CellStyleKind::Date | CellStyleKind::DateTime | CellStyleKind::Time => {
            if let Some(formatted) = format_excel_serial_date(num, style_kind, date1904) {
                return formatted;
            }
            trim_float_text(trimmed)
        }
        CellStyleKind::Percent => {
            let pct = num * 100.0;
            let rounded = format!("{pct:.2}");
            let clean = rounded.trim_end_matches('0').trim_end_matches('.');
            format!("{clean}%")
        }
        CellStyleKind::General => trim_float_text(trimmed),
    }
}

fn parse_worksheet_xml(
    name: &str,
    xml: &str,
    shared_strings: &[String],
    styles: &WorkbookStyles,
    date1904: bool,
) -> Result<ParsedExcelSheet, String> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|error| format!("解析工作表 {name} 失败：{error}"))?;

    let mut row_map: BTreeMap<usize, BTreeMap<usize, String>> = BTreeMap::new();
    let mut truncated = false;
    let mut sequential_row = 0usize;

    let Some(sheet_data) = doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "sheetData")
    else {
        return Ok(ParsedExcelSheet {
            name: name.to_string(),
            row_count: 0,
            col_count: 0,
            truncated: false,
            rows: Vec::new(),
        });
    };

    for row_node in sheet_data
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "row")
    {
        let row_idx = attr_value(row_node, "r")
            .and_then(|value| value.parse::<usize>().ok())
            .and_then(|one_based| one_based.checked_sub(1))
            .unwrap_or(sequential_row);
        sequential_row = row_idx + 1;

        if row_idx >= MAX_EXCEL_ROWS_PER_SHEET {
            truncated = true;
            continue;
        }

        let mut sequential_col = 0usize;
        for cell_node in row_node
            .children()
            .filter(|node| node.is_element() && node.tag_name().name() == "c")
        {
            let (cell_row, cell_col) = attr_value(cell_node, "r")
                .and_then(parse_cell_reference)
                .map(|(parsed_row, parsed_col)| (parsed_row, parsed_col))
                .unwrap_or((row_idx, sequential_col));
            sequential_col = cell_col + 1;

            if cell_row >= MAX_EXCEL_ROWS_PER_SHEET || cell_col >= MAX_EXCEL_COLS_PER_SHEET {
                truncated = true;
                continue;
            }

            let cell_type = attr_value(cell_node, "t").unwrap_or("n");
            let style_idx = attr_value(cell_node, "s").and_then(|v| v.parse::<usize>().ok());
            let style_kind = styles.kind_for(style_idx);

            let v_text = cell_node
                .children()
                .find(|node| node.is_element() && node.tag_name().name() == "v")
                .and_then(|node| node.text())
                .unwrap_or("");

            let value = match cell_type {
                "s" => v_text
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .and_then(|idx| shared_strings.get(idx))
                    .cloned()
                    .unwrap_or_default(),
                "inlineStr" => cell_node
                    .children()
                    .find(|node| node.is_element() && node.tag_name().name() == "is")
                    .map(collect_si_text)
                    .unwrap_or_default(),
                "b" => match v_text.trim() {
                    "1" => "TRUE".to_string(),
                    "0" => "FALSE".to_string(),
                    other => other.to_ascii_uppercase(),
                },
                "str" | "e" => v_text.to_string(),
                _ => format_numeric_value(v_text, style_kind, date1904),
            };

            let trimmed_value = value.trim_matches('\r').to_string();
            if !trimmed_value.is_empty() {
                row_map
                    .entry(cell_row)
                    .or_default()
                    .insert(cell_col, trimmed_value);
            }
        }
    }

    finalize_sparse_rows(name, row_map, truncated)
}

fn finalize_sparse_rows(
    name: &str,
    row_map: BTreeMap<usize, BTreeMap<usize, String>>,
    truncated: bool,
) -> Result<ParsedExcelSheet, String> {
    let Some(&max_row) = row_map.keys().max() else {
        return Ok(ParsedExcelSheet {
            name: name.to_string(),
            row_count: 0,
            col_count: 0,
            truncated,
            rows: Vec::new(),
        });
    };

    let max_col = row_map
        .values()
        .flat_map(|cols| cols.keys().copied())
        .max()
        .unwrap_or(0);

    let col_count = max_col + 1;
    let row_count = max_row + 1;
    let mut rows = Vec::with_capacity(row_count);

    for row_idx in 0..row_count {
        let mut row_cells = vec![String::new(); col_count];
        if let Some(cols) = row_map.get(&row_idx) {
            for (&col_idx, value) in cols {
                if col_idx < col_count {
                    row_cells[col_idx] = value.clone();
                }
            }
        }
        rows.push(row_cells);
    }

    Ok(ParsedExcelSheet {
        name: name.to_string(),
        row_count: rows.len(),
        col_count,
        truncated,
        rows,
    })
}

fn detect_csv_delimiter(text: &str) -> char {
    let sample_lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .collect();
    if sample_lines.is_empty() {
        return ',';
    }
    let count_outside_quotes = |line: &str, delimiter: char| -> usize {
        let mut count = 0usize;
        let mut in_quotes = false;
        for ch in line.chars() {
            if ch == '"' {
                in_quotes = !in_quotes;
            } else if ch == delimiter && !in_quotes {
                count += 1;
            }
        }
        count
    };
    let comma_hits: usize = sample_lines
        .iter()
        .map(|line| count_outside_quotes(line, ','))
        .sum();
    if comma_hits > 0 {
        return ',';
    }
    let tab_hits: usize = sample_lines
        .iter()
        .map(|line| count_outside_quotes(line, '\t'))
        .sum();
    if tab_hits > 0 {
        return '\t';
    }
    let semi_hits: usize = sample_lines
        .iter()
        .map(|line| count_outside_quotes(line, ';'))
        .sum();
    if semi_hits > 0 {
        return ';';
    }
    ','
}

pub fn parse_delimited_bytes(
    bytes: &[u8],
    sheet_name: &str,
    forced_delimiter: Option<u8>,
) -> ParsedExcelSheet {
    let text = String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .to_string();
    let delimiter = forced_delimiter
        .map(char::from)
        .unwrap_or_else(|| detect_csv_delimiter(&text));

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_cell = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    let mut truncated = false;

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    current_cell.push('"');
                    let _ = chars.next();
                } else {
                    in_quotes = false;
                }
            } else if ch != '\r' {
                current_cell.push(ch);
            }
            continue;
        }

        if ch == '"' && current_cell.is_empty() {
            in_quotes = true;
        } else if ch == delimiter {
            if current_row.len() < MAX_EXCEL_COLS_PER_SHEET {
                current_row.push(current_cell.trim().to_string());
            } else {
                truncated = true;
            }
            current_cell.clear();
        } else if ch == '\r' || ch == '\n' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                let _ = chars.next();
            }
            if current_row.len() < MAX_EXCEL_COLS_PER_SHEET {
                current_row.push(current_cell.trim().to_string());
            } else {
                truncated = true;
            }
            current_cell.clear();
            if rows.len() < MAX_EXCEL_ROWS_PER_SHEET {
                rows.push(std::mem::take(&mut current_row));
            } else {
                current_row.clear();
                truncated = true;
                break;
            }
        } else {
            current_cell.push(ch);
        }
    }

    if (!current_cell.is_empty() || !current_row.is_empty()) && rows.len() < MAX_EXCEL_ROWS_PER_SHEET {
        if current_row.len() < MAX_EXCEL_COLS_PER_SHEET {
            current_row.push(current_cell.trim().to_string());
        } else {
            truncated = true;
        }
        rows.push(current_row);
    }

    // Strip trailing completely empty rows.
    while rows
        .last()
        .is_some_and(|row| row.iter().all(|cell| cell.trim().is_empty()))
    {
        rows.pop();
    }

    let max_col = rows.iter().map(Vec::len).max().unwrap_or(0);
    // Trim trailing empty columns if present across all rows.
    let mut active_cols = 0usize;
    for row in &rows {
        for (idx, cell) in row.iter().enumerate() {
            if !cell.trim().is_empty() && idx + 1 > active_cols {
                active_cols = idx + 1;
            }
        }
    }
    let col_count = if active_cols > 0 { active_cols } else { max_col };
    for row in &mut rows {
        row.truncate(col_count);
        while row.len() < col_count {
            row.push(String::new());
        }
    }

    ParsedExcelSheet {
        name: sheet_name.to_string(),
        row_count: rows.len(),
        col_count,
        truncated,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn build_test_xlsx_bytes() -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default();

            zip.start_file("[Content_Types].xml", opts).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>"#,
            )
            .unwrap();

            zip.start_file("xl/workbook.xml", opts).unwrap();
            zip.write_all(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="销售汇总" sheetId="1" r:id="rId1"/>
    <sheet name="明细表" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#
                    .as_bytes(),
            )
            .unwrap();

            zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>"#,
            )
            .unwrap();

            zip.start_file("xl/sharedStrings.xml", opts).unwrap();
            zip.write_all(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>日期</t></si>
  <si><t>利润率</t></si>
  <si><r><t>富文本</t></r><r><t>地区</t></r></si>
</sst>"#
                    .as_bytes(),
            )
            .unwrap();

            zip.start_file("xl/styles.xml", opts).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="10"/>
  </cellXfs>
</styleSheet>"#,
            )
            .unwrap();

            zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
            zip.write_all(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="C1" t="s"><v>1</v></c>
      <c r="D1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" s="1"><v>45658</v></c>
      <c r="B2" t="inlineStr"><is><t>华东</t></is></c>
      <c r="C2" s="2"><v>0.185</v></c>
      <c r="D2" t="b"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>"#
                    .as_bytes(),
            )
            .unwrap();

            zip.start_file("xl/worksheets/sheet2.xml", opts).unwrap();
            zip.write_all(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="AA1" t="str"><v>公式结果</v></c>
    </row>
  </sheetData>
</worksheet>"#
                    .as_bytes(),
            )
            .unwrap();

            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn parses_xlsx_with_sparse_cols_dates_percentages_and_multi_sheets() {
        let bytes = build_test_xlsx_bytes();
        let sheets = parse_xlsx_reader(Cursor::new(bytes)).unwrap();
        assert_eq!(sheets.len(), 2);

        let s1 = &sheets[0];
        assert_eq!(s1.name, "销售汇总");
        assert_eq!(s1.row_count, 2);
        assert_eq!(s1.col_count, 4);
        assert_eq!(s1.rows[0], vec!["日期", "", "利润率", "富文本地区"]);
        assert_eq!(s1.rows[1], vec!["2025-01-01", "华东", "18.5%", "TRUE"]);

        let s2 = &sheets[1];
        assert_eq!(s2.name, "明细表");
        assert_eq!(s2.col_count, 27);
        assert_eq!(s2.rows[0][26], "公式结果");
    }

    #[test]
    fn parses_csv_with_bom_quotes_and_multiline_cells() {
        let csv = "\u{feff}模块,负责人,说明\n\"风控,核心\",张三,\"第一行\n第二行\"\"引用\"\"\"\n行情,李四,100\n";
        let sheet = parse_delimited_bytes(csv.as_bytes(), "Sheet1", None);
        assert_eq!(sheet.row_count, 3);
        assert_eq!(sheet.col_count, 3);
        assert_eq!(sheet.rows[0], vec!["模块", "负责人", "说明"]);
        assert_eq!(
            sheet.rows[1],
            vec!["风控,核心", "张三", "第一行\n第二行\"引用\""]
        );
        assert_eq!(sheet.rows[2], vec!["行情", "李四", "100"]);
    }
}
