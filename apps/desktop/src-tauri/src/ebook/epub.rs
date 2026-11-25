use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek},
    path::Path,
};

use roxmltree::{Document, Node, NodeType, ParsingOptions};
use serde::Serialize;
use zip::ZipArchive;

const MAX_ARCHIVE_BYTES: u64 = 1_073_741_824;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_XML_NODES: u32 = 100_000;
const MAX_TOC_ENTRIES: usize = 20_000;
const MAX_TOC_DEPTH: usize = 128;
pub(super) const MAX_MARKDOWN_BYTES: usize = 1_048_576;
const MAX_CONTENT_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CONTENT_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SECTION_HEADINGS: usize = 20_000;
const MAX_AI_CHAPTERS: usize = 40;
const MAX_AI_CHAPTER_TEXT_CHARS: usize = 4_000;
const MAX_IMPORT_WARNINGS: usize = 20;
const DC_NAMESPACE: &str = "http://purl.org/dc/elements/1.1/";
const EPUB_NAMESPACE: &str = "http://www.idpf.org/2007/ops";
const EPUB_LEGACY_NAMESPACE: &str = "http://www.idpf.org/2011/epub";
const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubOutline {
    title: String,
    markdown: String,
    chapter_count: usize,
    section_count: usize,
    enriched_chapter_count: usize,
    skipped_chapter_count: usize,
    warnings: Vec<String>,
    source_file: String,
}

#[derive(Clone)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

struct PackageInfo {
    title: Option<String>,
    nav_href: Option<String>,
    ncx_href: Option<String>,
}

#[derive(Clone)]
struct OutlineNode {
    label: String,
    children: Vec<OutlineNode>,
    target: Option<ChapterTarget>,
}

#[derive(Clone)]
struct ChapterTarget {
    path: String,
    fragment: Option<String>,
}

struct TocReference {
    path: Vec<usize>,
    label: String,
    target: ChapterTarget,
}

struct ContentGroup {
    archive_path: String,
    references: Vec<TocReference>,
}

struct HeadingEntry {
    level: u8,
    label: String,
    position: usize,
}

struct TextBlock {
    position: usize,
    text: String,
}

struct HeadingDocument {
    headings: Vec<HeadingEntry>,
    anchors: HashMap<String, usize>,
    heading_labels: HashMap<String, usize>,
    text_blocks: Vec<TextBlock>,
    truncated: bool,
}

pub(crate) struct EpubChapterText {
    pub root_index: usize,
    pub id: String,
    pub label: String,
    pub text: String,
    pub truncated: bool,
}

pub(crate) struct EpubChapterTexts {
    pub chapters: Vec<EpubChapterText>,
    pub unavailable_chapter_count: usize,
    pub omitted_chapter_count: usize,
}

#[derive(Default)]
struct EnrichmentStats {
    section_count: usize,
    enriched_chapter_count: usize,
    skipped_chapter_count: usize,
    warnings: Vec<String>,
}

#[tauri::command]
pub fn import_epub_toc(path: String) -> Result<EpubOutline, String> {
    let path = Path::new(path.trim());
    let mut archive = open_epub_archive(path)?;
    let (package, mut nodes, chapter_count, parse_warnings) = read_epub_navigation(&mut archive)?;

    let source_file = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("book.epub")
        .to_string();
    let fallback_title = Path::new(&source_file)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("未命名书籍");
    let title = normalize_text(package.title.as_deref().unwrap_or(fallback_title));
    let title = if title.is_empty() {
        fallback_title.to_string()
    } else {
        title
    };

    if nodes.is_empty() || chapter_count == 0 {
        return Err("没有在 EPUB 目录中找到可导入的章节。".to_string());
    }

    let original_nodes = nodes.clone();
    let mut enrichment = enrich_outline_from_content(&mut archive, &mut nodes);
    for warning in parse_warnings {
        push_import_warning(&mut enrichment.warnings, warning);
    }
    let markdown = match outline_to_markdown(&title, &nodes) {
        Ok(markdown) => markdown,
        Err(_) if enrichment.section_count > 0 => {
            nodes = original_nodes;
            enrichment.section_count = 0;
            enrichment.enriched_chapter_count = 0;
            push_import_warning(
                &mut enrichment.warnings,
                "补充的小标题超出目录导入上限，已保留原始目录".to_string(),
            );
            outline_to_markdown(&title, &nodes)?
        }
        Err(error) => return Err(error),
    };
    Ok(EpubOutline {
        title,
        markdown,
        chapter_count,
        section_count: enrichment.section_count,
        enriched_chapter_count: enrichment.enriched_chapter_count,
        skipped_chapter_count: enrichment.skipped_chapter_count,
        warnings: enrichment.warnings,
        source_file,
    })
}

fn open_epub_archive(path: &Path) -> Result<ZipArchive<File>, String> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Err("请选择 .epub 格式的电子书。".to_string());
    }

    let file = File::open(path).map_err(|_| "无法打开这个 EPUB 文件。".to_string())?;
    let file_size = file
        .metadata()
        .map_err(|_| "无法读取 EPUB 文件信息。".to_string())?
        .len();
    if file_size == 0 || file_size > MAX_ARCHIVE_BYTES {
        return Err("EPUB 文件为空或超过 1 GB 的导入上限。".to_string());
    }

    let archive =
        ZipArchive::new(file).map_err(|_| "文件不是有效的 EPUB/ZIP 压缩包。".to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("EPUB 包含过多文件条目，已停止解析。".to_string());
    }
    Ok(archive)
}

fn read_epub_navigation<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(PackageInfo, Vec<OutlineNode>, usize, Vec<String>), String> {
    let container_xml = read_zip_xml(archive, "META-INF/container.xml")?;
    let package_path = parse_container(&container_xml)?;
    drop(container_xml);

    let package_xml = read_zip_xml(archive, &package_path)?;
    let package = parse_package(&package_xml)?;
    drop(package_xml);

    let mut nav_error = None;
    if let Some(nav_href) = package.nav_href.as_deref() {
        let mut warnings = Vec::new();
        let result = (|| {
            let nav_path = resolve_package_href(&package_path, nav_href)?;
            let nav_xml = read_zip_xml(archive, &nav_path)?;
            parse_epub3_nav(&nav_xml, &nav_path, &mut warnings)
        })();
        match result {
            Ok((nodes, chapter_count))
                if !nodes.is_empty() && chapter_count > 0 && has_navigable_target(&nodes) =>
            {
                return Ok((package, nodes, chapter_count, warnings));
            }
            Ok(_) => nav_error = Some("EPUB 3 导航文件中没有可跳转的章节。".to_string()),
            Err(error) => nav_error = Some(error),
        }
    }

    if let Some(ncx_href) = package.ncx_href.as_deref() {
        let mut warnings = Vec::new();
        let result = (|| {
            let ncx_path = resolve_package_href(&package_path, ncx_href)?;
            let ncx_xml = read_zip_xml(archive, &ncx_path)?;
            parse_epub2_ncx(&ncx_xml, &ncx_path, &mut warnings)
        })();
        match result {
            Ok((nodes, chapter_count))
                if !nodes.is_empty() && chapter_count > 0 && has_navigable_target(&nodes) =>
            {
                if let Some(error) = nav_error {
                    let mut fallback_warnings = Vec::new();
                    push_import_warning(
                        &mut fallback_warnings,
                        format!("EPUB 3 目录不可用，已改用 NCX：{error}"),
                    );
                    for warning in warnings {
                        push_import_warning(&mut fallback_warnings, warning);
                    }
                    warnings = fallback_warnings;
                }
                return Ok((package, nodes, chapter_count, warnings));
            }
            Ok(_) => {
                let error = "EPUB 2 NCX 中没有可跳转的章节。";
                return Err(match nav_error {
                    Some(nav_error) => format!("{nav_error}；{error}"),
                    None => error.to_string(),
                });
            }
            Err(error) => {
                return Err(match nav_error {
                    Some(nav_error) => format!("{nav_error}；NCX 回退也失败：{error}"),
                    None => error,
                });
            }
        }
    }

    Err(nav_error
        .unwrap_or_else(|| "这本书没有可用的 EPUB 目录（EPUB 3 nav 或 EPUB 2 NCX）。".to_string()))
}

fn has_navigable_target(nodes: &[OutlineNode]) -> bool {
    nodes
        .iter()
        .any(|node| node.target.is_some() || has_navigable_target(&node.children))
}

fn read_zip_xml<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Result<String, String> {
    read_zip_xml_metered(archive, name, MAX_XML_BYTES)
        .map(|(xml, _)| xml)
        .map_err(|(error, _)| error)
}

fn read_zip_xml_metered<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max_bytes: u64,
) -> Result<(String, u64), (String, u64)> {
    let entry = archive
        .by_name(name)
        .map_err(|_| (format!("EPUB 中缺少 XML 文件：{name}"), 0))?;
    if entry.is_dir() || entry.size() > MAX_XML_BYTES {
        return Err((format!("EPUB XML 文件过大或无效：{name}"), 0));
    }

    let mut bytes = Vec::with_capacity(entry.size().min(max_bytes) as usize);
    if entry.take(max_bytes + 1).read_to_end(&mut bytes).is_err() {
        let bytes_read = bytes.len() as u64;
        return Err((format!("无法读取 EPUB XML 文件：{name}"), bytes_read));
    }
    let bytes_read = bytes.len() as u64;
    if bytes_read > max_bytes {
        return Err((
            format!("EPUB XML 文件解压后超过 {max_bytes} 字节：{name}"),
            bytes_read,
        ));
    }
    decode_xml(&bytes)
        .map(|xml| (xml, bytes_read))
        .map_err(|_| {
            (
                format!("EPUB XML 文件不是有效的 UTF-8/UTF-16：{name}"),
                bytes_read,
            )
        })
}

fn decode_xml(bytes: &[u8]) -> Result<String, ()> {
    if let Some(utf8) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(utf8.to_vec()).map_err(|_| ());
    }
    if let Some(utf16) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return decode_utf16(utf16, true);
    }
    if let Some(utf16) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return decode_utf16(utf16, false);
    }
    if bytes.starts_with(b"<\0?\0") {
        return decode_utf16(bytes, true);
    }
    if bytes.starts_with(b"\0<\0?") {
        return decode_utf16(bytes, false);
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| ())
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, ()> {
    if bytes.len() % 2 != 0 {
        return Err(());
    }
    let units = bytes.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .map_err(|_| ())
}

fn parse_xml<'input>(xml: &'input str, description: &str) -> Result<Document<'input>, String> {
    parse_xml_with_options(xml, description, false)
}

fn parse_navigation_xml<'input>(
    xml: &'input str,
    description: &str,
) -> Result<Document<'input>, String> {
    // EPUB permits internal DTD declarations. No external entity resolver is supplied.
    parse_xml_with_options(xml, description, true)
}

fn parse_xml_with_options<'input>(
    xml: &'input str,
    description: &str,
    allow_dtd: bool,
) -> Result<Document<'input>, String> {
    Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd,
            nodes_limit: MAX_XML_NODES,
            entity_resolver: None,
            ..ParsingOptions::default()
        },
    )
    .map_err(|error| match error {
        roxmltree::Error::NodesLimitReached => {
            format!("{description}的 XML 节点超过 {MAX_XML_NODES} 个。")
        }
        roxmltree::Error::DtdDetected => {
            format!("{description}包含当前解析器不支持的 DTD 声明。")
        }
        _ => {
            let position = error.pos();
            format!(
                "{description}的 XML 解析失败（第 {} 行、第 {} 列）：{error}。",
                position.row, position.col
            )
        }
    })
}

// Some otherwise readable books put HTML entities or bare ampersands in nav.xhtml.
// Only repair text and quoted attribute values; leave comments, CDATA and DTDs intact.
fn repair_common_xml_entities(xml: &str) -> Option<String> {
    #[derive(Clone, Copy)]
    enum Region {
        Text,
        Tag,
        SingleQuoted,
        DoubleQuoted,
        Comment,
        Cdata,
        ProcessingInstruction,
    }

    fn named_entity(name: &str) -> Option<&'static str> {
        match name.to_ascii_lowercase().as_str() {
            "nbsp" => Some("&#160;"),
            "mdash" => Some("&#8212;"),
            "ndash" => Some("&#8211;"),
            "ldquo" => Some("&#8220;"),
            "rdquo" => Some("&#8221;"),
            "lsquo" => Some("&#8216;"),
            "rsquo" => Some("&#8217;"),
            "hellip" => Some("&#8230;"),
            "copy" => Some("&#169;"),
            "reg" => Some("&#174;"),
            "trade" => Some("&#8482;"),
            "bull" => Some("&#8226;"),
            "middot" => Some("&#183;"),
            _ => None,
        }
    }

    let bytes = xml.as_bytes();
    let mut output = String::with_capacity(xml.len());
    let mut region = Region::Text;
    let mut i = 0;
    let mut copied_until = 0;
    let mut changed = false;
    while i < bytes.len() {
        match region {
            Region::Text if bytes[i..].starts_with(b"<!--") => {
                region = Region::Comment;
                i += 4;
            }
            Region::Text if bytes[i..].starts_with(b"<![CDATA[") => {
                region = Region::Cdata;
                i += 9;
            }
            Region::Text if bytes[i..].starts_with(b"<!DOCTYPE") => {
                // A DTD can contain quoted '>' characters and an internal subset.
                let mut subset_depth = 0_usize;
                let mut quote = None;
                i += 9;
                while i < bytes.len() {
                    let byte = bytes[i];
                    if let Some(delimiter) = quote {
                        if byte == delimiter {
                            quote = None;
                        }
                    } else {
                        match byte {
                            b'\'' | b'"' => quote = Some(byte),
                            b'[' => subset_depth += 1,
                            b']' => subset_depth = subset_depth.saturating_sub(1),
                            b'>' if subset_depth == 0 => {
                                i += 1;
                                break;
                            }
                            _ => {}
                        }
                    }
                    i += 1;
                }
            }
            Region::Text if bytes[i..].starts_with(b"<?") => {
                region = Region::ProcessingInstruction;
                i += 2;
            }
            Region::Text if bytes[i] == b'<' => {
                region = Region::Tag;
                i += 1;
            }
            Region::Tag if bytes[i] == b'\'' => {
                region = Region::SingleQuoted;
                i += 1;
            }
            Region::Tag if bytes[i] == b'"' => {
                region = Region::DoubleQuoted;
                i += 1;
            }
            Region::Tag if bytes[i] == b'>' => {
                region = Region::Text;
                i += 1;
            }
            Region::SingleQuoted if bytes[i] == b'\'' => {
                region = Region::Tag;
                i += 1;
            }
            Region::DoubleQuoted if bytes[i] == b'"' => {
                region = Region::Tag;
                i += 1;
            }
            Region::Comment if bytes[i..].starts_with(b"-->") => {
                region = Region::Text;
                i += 3;
            }
            Region::Cdata if bytes[i..].starts_with(b"]]>") => {
                region = Region::Text;
                i += 3;
            }
            Region::ProcessingInstruction if bytes[i..].starts_with(b"?>") => {
                region = Region::Text;
                i += 2;
            }
            Region::Text | Region::SingleQuoted | Region::DoubleQuoted if bytes[i] == b'&' => {
                let start = i + 1;
                let mut end = start;
                let mut replacement = None;
                if bytes.get(start).is_some_and(u8::is_ascii_alphabetic) {
                    while bytes.get(end).is_some_and(u8::is_ascii_alphanumeric) {
                        end += 1;
                    }
                    if bytes.get(end) == Some(&b';') {
                        replacement = named_entity(&xml[start..end]).map(|value| (end + 1, value));
                        if replacement.is_none() {
                            i += 1; // XML predefined or an entity declared in a DTD.
                            continue;
                        }
                    }
                } else if bytes.get(start) == Some(&b'#') {
                    end += 1;
                    let hexadecimal = matches!(bytes.get(end), Some(b'x' | b'X'));
                    if hexadecimal {
                        end += 1;
                    }
                    let digits_start = end;
                    while bytes.get(end).is_some_and(|byte| {
                        if hexadecimal {
                            byte.is_ascii_hexdigit()
                        } else {
                            byte.is_ascii_digit()
                        }
                    }) {
                        end += 1;
                    }
                    if end > digits_start && bytes.get(end) == Some(&b';') {
                        i += 1;
                        continue;
                    }
                }
                let (next, value) = replacement.unwrap_or((i + 1, "&amp;"));
                output.push_str(&xml[copied_until..i]);
                output.push_str(value);
                copied_until = next;
                i = next;
                changed = true;
            }
            _ => i += 1,
        }
    }
    if !changed {
        return None;
    }
    output.push_str(&xml[copied_until..]);
    Some(output)
}

fn parse_container(xml: &str) -> Result<String, String> {
    let document = parse_xml(xml, "EPUB 容器描述文件")?;
    let rootfile = document
        .descendants()
        .find(|node| {
            has_local_name(*node, "rootfile")
                && node.attribute("media-type") == Some("application/oebps-package+xml")
        })
        .or_else(|| {
            document
                .descendants()
                .find(|node| has_local_name(*node, "rootfile"))
        })
        .ok_or_else(|| "EPUB 容器描述文件没有指定 OPF 书籍信息文件。".to_string())?;
    let full_path = rootfile
        .attribute("full-path")
        .ok_or_else(|| "EPUB 容器描述文件缺少 OPF 文件路径。".to_string())?;
    normalize_archive_path(full_path)
}

fn parse_package(xml: &str) -> Result<PackageInfo, String> {
    let document = parse_xml(xml, "EPUB OPF 文件")?;
    let metadata = document
        .descendants()
        .find(|node| has_local_name(*node, "metadata"))
        .ok_or_else(|| "EPUB OPF 文件缺少 metadata 元素。".to_string())?;
    let title_node = metadata
        .children()
        .find(|node| {
            node.is_element()
                && node.tag_name().name() == "title"
                && node.tag_name().namespace() == Some(DC_NAMESPACE)
        })
        .or_else(|| {
            metadata
                .children()
                .find(|node| has_local_name(*node, "title"))
        });
    let title = title_node
        .map(node_text)
        .map(|title| normalize_text(&title))
        .filter(|title| !title.is_empty());

    let manifest = document
        .descendants()
        .find(|node| has_local_name(*node, "manifest"))
        .ok_or_else(|| "EPUB OPF 文件缺少 manifest 元素。".to_string())?;
    let items: Vec<ManifestItem> = manifest
        .children()
        .filter(|node| has_local_name(*node, "item"))
        .filter_map(|node| {
            Some(ManifestItem {
                id: node.attribute("id")?.to_string(),
                href: node.attribute("href")?.to_string(),
                media_type: node.attribute("media-type").unwrap_or_default().to_string(),
                properties: node.attribute("properties").unwrap_or_default().to_string(),
            })
        })
        .collect();

    let nav_href = items
        .iter()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|property| property == "nav")
        })
        .map(|item| item.href.clone());

    let spine = document
        .descendants()
        .find(|node| has_local_name(*node, "spine"));
    let ncx_id = spine.and_then(|node| node.attribute("toc"));
    let ncx_href = ncx_id
        .and_then(|id| items.iter().find(|item| item.id == id))
        .or_else(|| items.iter().find(|item| item.media_type == NCX_MEDIA_TYPE))
        .map(|item| item.href.clone());

    Ok(PackageInfo {
        title,
        nav_href,
        ncx_href,
    })
}

fn parse_epub3_nav(
    xml: &str,
    nav_path: &str,
    warnings: &mut Vec<String>,
) -> Result<(Vec<OutlineNode>, usize), String> {
    let description = format!("EPUB 3 导航文件（{nav_path}）");
    let document = match parse_navigation_xml(xml, &description) {
        Ok(document) => document,
        Err(original_error) => {
            if let Some(repaired) = repair_common_xml_entities(xml) {
                if let Ok(document) = parse_navigation_xml(&repaired, &description) {
                    let result = parse_epub3_nav_document(&document, nav_path, warnings);
                    if result.is_ok() {
                        push_import_warning(
                            warnings,
                            "导航文件包含不规范的 XML 实体，已兼容读取目录。".to_string(),
                        );
                    }
                    return result;
                }
            }
            return Err(original_error);
        }
    };
    parse_epub3_nav_document(&document, nav_path, warnings)
}

fn parse_epub3_nav_document(
    document: &Document<'_>,
    nav_path: &str,
    warnings: &mut Vec<String>,
) -> Result<(Vec<OutlineNode>, usize), String> {
    let navs: Vec<_> = document
        .descendants()
        .filter(|node| has_local_name(*node, "nav"))
        .collect();
    let has_type = |node: Node<'_, '_>, namespace: &str, value: &str| {
        node.attribute((namespace, "type"))
            .is_some_and(|types| types.split_whitespace().any(|token| token == value))
    };
    let has_list = |node: Node<'_, '_>| node.children().any(|child| has_local_name(child, "ol"));
    let toc_nav = navs
        .iter()
        .copied()
        .find(|node| has_type(*node, EPUB_NAMESPACE, "toc"))
        .or_else(|| {
            let legacy = navs
                .iter()
                .copied()
                .find(|node| has_type(*node, EPUB_LEGACY_NAMESPACE, "toc"));
            if legacy.is_some() {
                push_import_warning(
                    warnings,
                    "目录使用旧版 epub:type 命名空间，已兼容读取。".to_string(),
                );
            }
            legacy
        })
        .or_else(|| {
            let identified = navs.iter().copied().find(|node| {
                has_list(*node)
                    && !nav_declares_other_navigation(*node)
                    && (node.attribute("id") == Some("toc")
                        || node.attribute("role").is_some_and(|roles| {
                            roles.split_whitespace().any(|role| role == "doc-toc")
                        }))
            });
            if identified.is_some() {
                push_import_warning(
                    warnings,
                    "目录未使用标准 epub:type，已按 toc 标识读取。".to_string(),
                );
            }
            identified
        })
        .or_else(|| {
            let mut candidates = navs.iter().copied().filter(|node| {
                has_list(*node)
                    && !node
                        .attributes()
                        .any(|attribute| attribute.name() == "type")
            });
            let candidate = candidates.next();
            if candidate.is_some() && candidates.next().is_none() {
                push_import_warning(
                    warnings,
                    "目录没有 epub:type 标识，已读取唯一的导航列表。".to_string(),
                );
                candidate
            } else {
                None
            }
        })
        .ok_or_else(|| "EPUB 3 导航文件中没有目录列表。".to_string())?;
    let list = toc_nav
        .children()
        .find(|node| has_local_name(*node, "ol"))
        .ok_or_else(|| "EPUB 3 目录中没有 ol 列表。".to_string())?;
    let mut count = 0;
    let nodes = parse_html_list(list, 1, &mut count, nav_path, warnings)?;
    Ok((nodes, count))
}

fn nav_declares_other_navigation(node: Node<'_, '_>) -> bool {
    node.attributes().any(|attribute| {
        attribute.name() == "type"
            && attribute
                .value()
                .split_whitespace()
                .any(|value| matches!(value, "landmarks" | "page-list"))
    })
}

fn parse_html_list(
    list: Node<'_, '_>,
    depth: usize,
    count: &mut usize,
    nav_path: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<OutlineNode>, String> {
    if depth > MAX_TOC_DEPTH {
        return Err("EPUB 目录层级超过 128 层，已停止导入。".to_string());
    }
    let mut nodes = Vec::new();
    for item in list.children().filter(|node| has_local_name(*node, "li")) {
        let label_node = item
            .children()
            .find(|node| node.is_element() && matches!(node.tag_name().name(), "a" | "span"));
        let label = label_node
            .map(node_text)
            .map(|text| normalize_text(&text))
            .unwrap_or_default();
        let mut children = Vec::new();
        for child_list in item.children().filter(|node| has_local_name(*node, "ol")) {
            children.extend(parse_html_list(
                child_list,
                depth + 1,
                count,
                nav_path,
                warnings,
            )?);
        }
        if label.is_empty() {
            nodes.extend(children);
            continue;
        }
        register_toc_entry(count)?;
        let target = label_node
            .and_then(|node| node.attribute("href"))
            .and_then(|href| match resolve_content_href(nav_path, href) {
                Ok(target) => Some(target),
                Err(error) => {
                    push_import_warning(
                        warnings,
                        format!(
                            "目录项“{}”的链接无法解析（{error}）",
                            truncate_chars(&label, 80)
                        ),
                    );
                    None
                }
            });
        nodes.push(OutlineNode {
            label,
            children,
            target,
        });
    }
    Ok(nodes)
}

fn parse_epub2_ncx(
    xml: &str,
    ncx_path: &str,
    warnings: &mut Vec<String>,
) -> Result<(Vec<OutlineNode>, usize), String> {
    let description = format!("EPUB 2 NCX 目录文件（{ncx_path}）");
    let document = match parse_navigation_xml(xml, &description) {
        Ok(document) => document,
        Err(original_error) => {
            if let Some(repaired) = repair_common_xml_entities(xml) {
                if let Ok(document) = parse_navigation_xml(&repaired, &description) {
                    let result = parse_epub2_ncx_document(&document, ncx_path, warnings);
                    if result.is_ok() {
                        push_import_warning(
                            warnings,
                            "NCX 包含不规范的 XML 实体，已兼容读取目录。".to_string(),
                        );
                    }
                    return result;
                }
            }
            return Err(original_error);
        }
    };
    parse_epub2_ncx_document(&document, ncx_path, warnings)
}

fn parse_epub2_ncx_document(
    document: &Document<'_>,
    ncx_path: &str,
    warnings: &mut Vec<String>,
) -> Result<(Vec<OutlineNode>, usize), String> {
    let nav_map = document
        .descendants()
        .find(|node| has_local_name(*node, "navMap"))
        .ok_or_else(|| "EPUB 2 NCX 文件中没有 navMap。".to_string())?;
    let mut count = 0;
    let nodes = parse_ncx_points(nav_map, 1, &mut count, ncx_path, warnings)?;
    Ok((nodes, count))
}

fn parse_ncx_points(
    parent: Node<'_, '_>,
    depth: usize,
    count: &mut usize,
    ncx_path: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<OutlineNode>, String> {
    if depth > MAX_TOC_DEPTH {
        return Err("EPUB 目录层级超过 128 层，已停止导入。".to_string());
    }
    let mut nodes = Vec::new();
    for point in parent
        .children()
        .filter(|node| has_local_name(*node, "navPoint"))
    {
        let label = point
            .children()
            .find(|node| has_local_name(*node, "navLabel"))
            .and_then(|nav_label| {
                nav_label
                    .descendants()
                    .find(|node| has_local_name(*node, "text"))
            })
            .map(node_text)
            .map(|text| normalize_text(&text))
            .unwrap_or_default();
        let children = parse_ncx_points(point, depth + 1, count, ncx_path, warnings)?;
        if label.is_empty() {
            nodes.extend(children);
            continue;
        }
        register_toc_entry(count)?;
        let content_src = point
            .children()
            .find(|node| has_local_name(*node, "content"))
            .and_then(|node| node.attribute("src"));
        let target = content_src.and_then(|src| match resolve_content_href(ncx_path, src) {
            Ok(target) => Some(target),
            Err(error) => {
                push_import_warning(
                    warnings,
                    format!(
                        "目录项“{}”的链接无法解析（{error}）",
                        truncate_chars(&label, 80)
                    ),
                );
                None
            }
        });
        nodes.push(OutlineNode {
            label,
            children,
            target,
        });
    }
    Ok(nodes)
}

fn enrich_outline_from_content<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    nodes: &mut [OutlineNode],
) -> EnrichmentStats {
    let groups = collect_content_groups(nodes);
    let mut stats = EnrichmentStats::default();
    let mut total_content_bytes = 0_u64;

    for group in groups {
        let (document_size, is_directory) = match archive.by_name(&group.archive_path) {
            Ok(entry) => (entry.size(), entry.is_dir()),
            Err(error) => {
                stats.skipped_chapter_count += group.references.len();
                push_import_warning(
                    &mut stats.warnings,
                    format!("目录关联的正文文件无法读取（{error}）"),
                );
                continue;
            }
        };
        if is_directory || document_size > MAX_CONTENT_DOCUMENT_BYTES {
            stats.skipped_chapter_count += group.references.len();
            push_import_warning(
                &mut stats.warnings,
                format!(
                    "目录关联的正文文件超过单文件 8 MB 上限，已跳过 {} 个目录项",
                    group.references.len()
                ),
            );
            continue;
        }
        if total_content_bytes.saturating_add(document_size) > MAX_CONTENT_TOTAL_BYTES {
            stats.skipped_chapter_count += group.references.len();
            push_import_warning(
                &mut stats.warnings,
                "正文解析达到 128 MB 累计读取上限，后续章节已跳过".to_string(),
            );
            continue;
        }

        let remaining_bytes = MAX_CONTENT_TOTAL_BYTES.saturating_sub(total_content_bytes);
        let content_limit = MAX_CONTENT_DOCUMENT_BYTES.min(remaining_bytes);
        let content = match read_zip_xml_metered(archive, &group.archive_path, content_limit) {
            Ok((content, bytes_read)) => {
                total_content_bytes = total_content_bytes.saturating_add(bytes_read);
                content
            }
            Err((error, bytes_read)) => {
                total_content_bytes = total_content_bytes.saturating_add(bytes_read);
                stats.skipped_chapter_count += group.references.len();
                push_import_warning(
                    &mut stats.warnings,
                    format!(
                        "正文文件无法解析，已跳过 {} 个目录项（{error}）",
                        group.references.len()
                    ),
                );
                continue;
            }
        };

        let document = match extract_heading_document(&content) {
            Ok(document) => document,
            Err(error) => {
                stats.skipped_chapter_count += group.references.len();
                push_import_warning(
                    &mut stats.warnings,
                    format!(
                        "正文 XHTML 结构无效，已跳过 {} 个目录项（{error}）",
                        group.references.len()
                    ),
                );
                continue;
            }
        };
        if document.truncated {
            push_import_warning(
                &mut stats.warnings,
                format!(
                    "正文小标题超过 {MAX_SECTION_HEADINGS} 条，仅提取前 {MAX_SECTION_HEADINGS} 条"
                ),
            );
        }
        if document.headings.is_empty() {
            continue;
        }

        for reference in &group.references {
            let heading_index = find_heading_for_reference(
                &document,
                &reference.target,
                &reference.label,
                group.references.len() == 1,
            );
            let Some(heading_index) = heading_index else {
                stats.skipped_chapter_count += 1;
                push_import_warning(
                    &mut stats.warnings,
                    format!(
                        "目录项“{}”没有可对应的正文小标题或锚点",
                        truncate_chars(&reference.label, 80)
                    ),
                );
                continue;
            };

            let include_heading =
                !same_heading_label(&reference.label, &document.headings[heading_index].label);
            let extracted = heading_subtree(&document.headings, heading_index, include_heading);
            if let Some(node) = outline_node_mut(nodes, &reference.path) {
                let added = merge_heading_nodes(&mut node.children, extracted);
                if added > 0 {
                    stats.section_count += added;
                    stats.enriched_chapter_count += 1;
                }
            }
        }
    }

    stats
}

pub(crate) fn extract_epub_chapter_texts(path: String) -> Result<EpubChapterTexts, String> {
    let path = Path::new(path.trim());
    let mut archive = open_epub_archive(path)?;
    let (_, nodes, _, _) = read_epub_navigation(&mut archive)?;
    let included_chapter_count = nodes.len().min(MAX_AI_CHAPTERS);
    let omitted_chapter_count = nodes.len().saturating_sub(included_chapter_count);
    let mut unavailable_chapter_count = 0;
    let mut groups = Vec::<ContentGroup>::new();
    let mut group_indices = HashMap::<String, usize>::new();

    for (root_index, node) in nodes.iter().take(included_chapter_count).enumerate() {
        let Some(target) = &node.target else {
            unavailable_chapter_count += 1;
            continue;
        };
        let group_index = *group_indices.entry(target.path.clone()).or_insert_with(|| {
            let index = groups.len();
            groups.push(ContentGroup {
                archive_path: target.path.clone(),
                references: Vec::new(),
            });
            index
        });
        groups[group_index].references.push(TocReference {
            path: vec![root_index],
            label: node.label.clone(),
            target: target.clone(),
        });
    }

    let mut total_content_bytes = 0_u64;
    let mut chapters = Vec::new();
    for group in groups {
        let (document_size, is_directory) = match archive.by_name(&group.archive_path) {
            Ok(entry) => (entry.size(), entry.is_dir()),
            Err(_) => {
                unavailable_chapter_count += group.references.len();
                continue;
            }
        };
        if is_directory || document_size > MAX_CONTENT_DOCUMENT_BYTES {
            unavailable_chapter_count += group.references.len();
            continue;
        }
        if total_content_bytes.saturating_add(document_size) > MAX_CONTENT_TOTAL_BYTES {
            unavailable_chapter_count += group.references.len();
            continue;
        }

        let remaining_bytes = MAX_CONTENT_TOTAL_BYTES.saturating_sub(total_content_bytes);
        let content_limit = MAX_CONTENT_DOCUMENT_BYTES.min(remaining_bytes);
        let content = match read_zip_xml_metered(&mut archive, &group.archive_path, content_limit) {
            Ok((content, bytes_read)) => {
                total_content_bytes = total_content_bytes.saturating_add(bytes_read);
                content
            }
            Err((_, bytes_read)) => {
                total_content_bytes = total_content_bytes.saturating_add(bytes_read);
                unavailable_chapter_count += group.references.len();
                continue;
            }
        };
        let document = match extract_heading_document(&content) {
            Ok(document) => document,
            Err(_) => {
                unavailable_chapter_count += group.references.len();
                continue;
            }
        };

        let mut starts = Vec::new();
        for reference in &group.references {
            let Some(root_index) = reference.path.first().copied() else {
                unavailable_chapter_count += 1;
                continue;
            };
            if let Some(start) = find_text_start(
                &document,
                &reference.target,
                &reference.label,
                group.references.len() == 1,
            ) {
                starts.push((root_index, reference.label.clone(), start));
            } else {
                unavailable_chapter_count += 1;
            }
        }
        starts.sort_by_key(|(root_index, _, position)| (*position, *root_index));

        for (root_index, label, start) in &starts {
            let end = starts
                .iter()
                .map(|(_, _, position)| *position)
                .filter(|position| position > start)
                .min()
                .unwrap_or(usize::MAX);
            let raw_text = document
                .text_blocks
                .iter()
                .filter(|block| block.position >= *start && block.position < end)
                .map(|block| block.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let normalized_text = normalize_text(&raw_text);
            if normalized_text.is_empty() {
                unavailable_chapter_count += 1;
                continue;
            }
            let mut characters = normalized_text.chars();
            let text: String = characters
                .by_ref()
                .take(MAX_AI_CHAPTER_TEXT_CHARS)
                .collect();
            let truncated = characters.next().is_some();
            chapters.push(EpubChapterText {
                root_index: *root_index,
                id: format!("chapter-{root_index}"),
                label: label.clone(),
                text,
                truncated,
            });
        }
    }

    chapters.sort_by_key(|chapter| chapter.root_index);
    Ok(EpubChapterTexts {
        chapters,
        unavailable_chapter_count,
        omitted_chapter_count,
    })
}

pub(crate) fn insert_ai_chapter_summaries(
    markdown: &str,
    summaries: &[(usize, String)],
) -> Result<String, String> {
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err("EPUB 目录内容超过 1 MB，无法添加章节摘要。".to_string());
    }
    let mut lines: Vec<String> = markdown.lines().map(str::to_string).collect();
    for (root_index, summary) in summaries {
        let top_level_lines: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter_map(|(line_index, line)| {
                (line.starts_with("- ") && line.trim_start() == line).then_some(line_index)
            })
            .collect();
        let Some(start) = top_level_lines.get(*root_index).copied() else {
            continue;
        };
        let insert_at = top_level_lines
            .iter()
            .copied()
            .find(|line_index| *line_index > start)
            .unwrap_or(lines.len());
        let summary = normalize_text(summary);
        if summary.is_empty() {
            continue;
        }
        lines.insert(
            insert_at,
            format!("  - AI 章节摘要：{}", escape_markdown(&summary)),
        );
        if lines.join("\n").len() > MAX_MARKDOWN_BYTES {
            return Err("添加章节摘要后内容超过 1 MB，已停止生成。".to_string());
        }
    }

    let mut result = lines.join("\n");
    if markdown.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

fn find_text_start(
    document: &HeadingDocument,
    target: &ChapterTarget,
    label: &str,
    allow_first_content: bool,
) -> Option<usize> {
    if let Some(fragment) = &target.fragment {
        if let Some(position) = document.anchors.get(fragment) {
            return Some(*position);
        }
    }

    if let Some(index) = document.heading_labels.get(&heading_label_key(label)) {
        return document
            .headings
            .get(*index)
            .map(|heading| heading.position);
    }

    if allow_first_content {
        document.text_blocks.first().map(|block| block.position)
    } else {
        None
    }
}

fn collect_content_groups(nodes: &[OutlineNode]) -> Vec<ContentGroup> {
    fn visit(
        nodes: &[OutlineNode],
        path: &mut Vec<usize>,
        groups: &mut Vec<ContentGroup>,
        group_indices: &mut HashMap<String, usize>,
    ) {
        for (index, node) in nodes.iter().enumerate() {
            path.push(index);
            if let Some(target) = &node.target {
                let group_index = *group_indices.entry(target.path.clone()).or_insert_with(|| {
                    let index = groups.len();
                    groups.push(ContentGroup {
                        archive_path: target.path.clone(),
                        references: Vec::new(),
                    });
                    index
                });
                groups[group_index].references.push(TocReference {
                    path: path.clone(),
                    label: node.label.clone(),
                    target: target.clone(),
                });
            }
            visit(&node.children, path, groups, group_indices);
            path.pop();
        }
    }

    let mut groups = Vec::new();
    let mut group_indices = HashMap::new();
    visit(nodes, &mut Vec::new(), &mut groups, &mut group_indices);
    groups
}

fn extract_heading_document(xml: &str) -> Result<HeadingDocument, String> {
    let document = parse_xml(xml, "EPUB XHTML 正文")?;
    let elements: Vec<_> = document
        .descendants()
        .filter(|node| node.is_element())
        .collect();
    let mut headings = Vec::new();
    let mut anchors = HashMap::new();
    let mut heading_labels = HashMap::new();
    let mut text_blocks = Vec::new();
    let mut truncated = false;

    for (position, node) in elements.iter().enumerate() {
        for attribute in ["id", "name"] {
            if let Some(value) = node.attribute(attribute) {
                anchors.entry(value.to_string()).or_insert(position);
            }
        }
        let Some(level) = heading_level(node.tag_name().name()) else {
            if is_text_block(*node) {
                let text = normalize_text(&node_text(*node));
                if !text.is_empty() {
                    text_blocks.push(TextBlock { position, text });
                }
            }
            continue;
        };
        let label = normalize_text(&node_text(*node));
        if label.is_empty() {
            continue;
        }
        if headings.len() >= MAX_SECTION_HEADINGS {
            truncated = true;
        } else {
            let label = truncate_chars(&label, 300);
            heading_labels
                .entry(heading_label_key(&label))
                .or_insert(headings.len());
            headings.push(HeadingEntry {
                level,
                label,
                position,
            });
        }

        if !label.is_empty() {
            text_blocks.push(TextBlock {
                position,
                text: label,
            });
        }
    }

    Ok(HeadingDocument {
        headings,
        anchors,
        heading_labels,
        text_blocks,
        truncated,
    })
}

fn is_text_block(node: Node<'_, '_>) -> bool {
    if node.ancestors().any(|ancestor| {
        ["head", "nav", "script", "style", "noscript"]
            .iter()
            .any(|name| {
                ancestor.is_element() && ancestor.tag_name().name().eq_ignore_ascii_case(name)
            })
    }) {
        return false;
    }

    let has_direct_child = |names: &[&str]| {
        node.children().any(|child| {
            child.is_element()
                && names
                    .iter()
                    .any(|name| child.tag_name().name().eq_ignore_ascii_case(name))
        })
    };
    match node.tag_name().name().to_ascii_lowercase().as_str() {
        "p" | "pre" | "dt" | "dd" | "figcaption" | "caption" => true,
        "li" => !has_direct_child(&["p", "ul", "ol", "li"]),
        "blockquote" => !has_direct_child(&["p", "blockquote"]),
        "td" | "th" => !has_direct_child(&["p", "ul", "ol", "table"]),
        "div" | "section" | "article" => !has_direct_child(&[
            "div",
            "section",
            "article",
            "p",
            "pre",
            "ul",
            "ol",
            "table",
            "blockquote",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
        ]),
        _ => false,
    }
}

fn heading_level(name: &str) -> Option<u8> {
    match name {
        "h1" => Some(1),
        "h2" => Some(2),
        "h3" => Some(3),
        "h4" => Some(4),
        "h5" => Some(5),
        "h6" => Some(6),
        _ => None,
    }
}

fn find_heading_for_reference(
    document: &HeadingDocument,
    target: &ChapterTarget,
    label: &str,
    allow_first_heading: bool,
) -> Option<usize> {
    if let Some(fragment) = &target.fragment {
        if let Some(anchor_position) = document.anchors.get(fragment) {
            let index = document
                .headings
                .partition_point(|heading| heading.position < *anchor_position);
            if index < document.headings.len() {
                return Some(index);
            }
        }
    }

    let normalized_label = heading_label_key(label);
    if let Some(index) = document.heading_labels.get(&normalized_label) {
        return Some(*index);
    }

    if allow_first_heading {
        document.headings.first().map(|_| 0)
    } else {
        None
    }
}

fn heading_subtree(
    headings: &[HeadingEntry],
    index: usize,
    include_heading: bool,
) -> Vec<OutlineNode> {
    let Some(heading) = headings.get(index) else {
        return Vec::new();
    };
    let end = headings[index + 1..]
        .iter()
        .position(|candidate| candidate.level <= heading.level)
        .map(|offset| index + 1 + offset)
        .unwrap_or(headings.len());
    let mut cursor = index + 1;
    let children = build_heading_nodes(&headings[..end], &mut cursor, heading.level);
    if include_heading {
        vec![OutlineNode {
            label: heading.label.clone(),
            children,
            target: None,
        }]
    } else {
        children
    }
}

fn build_heading_nodes(
    headings: &[HeadingEntry],
    cursor: &mut usize,
    parent_level: u8,
) -> Vec<OutlineNode> {
    let mut nodes = Vec::new();
    while let Some(heading) = headings.get(*cursor) {
        if heading.level <= parent_level {
            break;
        }
        *cursor += 1;
        let children = build_heading_nodes(headings, cursor, heading.level);
        nodes.push(OutlineNode {
            label: heading.label.clone(),
            children,
            target: None,
        });
    }
    nodes
}

fn same_heading_label(left: &str, right: &str) -> bool {
    heading_label_key(left) == heading_label_key(right)
}

fn heading_label_key(value: &str) -> String {
    truncate_chars(&normalize_text(value), 300).to_lowercase()
}

fn merge_heading_nodes(existing: &mut Vec<OutlineNode>, incoming: Vec<OutlineNode>) -> usize {
    let mut indices = HashMap::new();
    for (index, node) in existing.iter().enumerate() {
        indices
            .entry(heading_label_key(&node.label))
            .or_insert(index);
    }
    let mut added = 0;
    for candidate in incoming {
        let key = heading_label_key(&candidate.label);
        if let Some(index) = indices.get(&key).copied() {
            added += merge_heading_nodes(&mut existing[index].children, candidate.children);
        } else {
            added += count_outline_nodes(&candidate);
            indices.insert(key, existing.len());
            existing.push(candidate);
        }
    }
    added
}

fn count_outline_nodes(node: &OutlineNode) -> usize {
    1 + node.children.iter().map(count_outline_nodes).sum::<usize>()
}

fn outline_node_mut<'a>(
    nodes: &'a mut [OutlineNode],
    path: &[usize],
) -> Option<&'a mut OutlineNode> {
    let (index, rest) = path.split_first()?;
    let node = nodes.get_mut(*index)?;
    if rest.is_empty() {
        Some(node)
    } else {
        outline_node_mut(&mut node.children, rest)
    }
}

fn push_import_warning(warnings: &mut Vec<String>, warning: String) {
    let warning = truncate_chars(&warning, 180);
    if warnings.len() < MAX_IMPORT_WARNINGS - 1 {
        warnings.push(warning);
    } else if warnings.len() == MAX_IMPORT_WARNINGS - 1 {
        warnings.push("其余解析提示已省略".to_string());
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut characters = value.chars();
    let truncated: String = characters.by_ref().take(max_chars).collect();
    if characters.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn register_toc_entry(count: &mut usize) -> Result<(), String> {
    *count += 1;
    if *count > MAX_TOC_ENTRIES {
        return Err("EPUB 目录超过 20,000 个条目，已停止导入。".to_string());
    }
    Ok(())
}

fn outline_to_markdown(title: &str, nodes: &[OutlineNode]) -> Result<String, String> {
    let mut markdown = format!("# {}\n\n", escape_markdown(title));
    append_markdown_nodes(nodes, 0, &mut markdown)?;
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err("生成的目录内容超过 1 MB，无法导入。".to_string());
    }
    Ok(markdown)
}

fn append_markdown_nodes(
    nodes: &[OutlineNode],
    depth: usize,
    markdown: &mut String,
) -> Result<(), String> {
    if depth > MAX_TOC_DEPTH {
        return Err("EPUB 目录层级超过 128 层，已停止导入。".to_string());
    }
    for node in nodes {
        markdown.push_str(&"  ".repeat(depth));
        markdown.push_str("- ");
        markdown.push_str(&escape_markdown(&node.label));
        if let Some(target) = &node.target {
            let mut href = target.path.clone();
            if let Some(fragment) = &target.fragment {
                href.push('#');
                href.push_str(fragment);
            }
            markdown.push_str(" <!-- seamind:epub-href=");
            markdown.push_str(&encode_node_metadata(&href));
            markdown.push_str(" -->");
        }
        markdown.push('\n');
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err("生成的目录内容超过 1 MB，无法导入。".to_string());
        }
        append_markdown_nodes(&node.children, depth + 1, markdown)?;
    }
    Ok(())
}

fn encode_node_metadata(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    let starts_with_list_marker = ["- ", "+ ", "* "]
        .iter()
        .any(|marker| value.starts_with(*marker));
    for (index, character) in value.chars().enumerate() {
        if matches!(
            character,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|'
        ) || (index == 0 && starts_with_list_marker && matches!(character, '-' | '+'))
        {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn node_text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|descendant| descendant.node_type() == NodeType::Text)
        .filter_map(|descendant| descendant.text())
        .collect::<String>()
}

fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_local_name(node: Node<'_, '_>, expected: &str) -> bool {
    node.is_element() && node.tag_name().name() == expected
}

fn normalize_archive_path(path: &str) -> Result<String, String> {
    if path.contains('\\') {
        return Err("EPUB OPF 文件路径包含不支持的反斜杠。".to_string());
    }
    let path = path.trim_start_matches('/');
    let resolved = resolve_path_segments(Vec::new(), path)?;
    if resolved.is_empty() {
        return Err("EPUB OPF 文件路径为空。".to_string());
    }
    Ok(resolved.join("/"))
}

fn resolve_package_href(package_path: &str, href: &str) -> Result<String, String> {
    if href.contains('\\') {
        return Err("EPUB 目录链接包含不支持的反斜杠。".to_string());
    }
    if href.starts_with("//") {
        return Err("EPUB 目录包含外部链接，无法作为本地文件读取。".to_string());
    }
    let path = href.split(['?', '#']).next().unwrap_or_default();
    if path.is_empty() {
        return Err("EPUB 目录链接没有文件路径。".to_string());
    }
    let first_segment = path
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();
    if first_segment.contains(':') {
        return Err("EPUB 目录包含外部链接，无法作为本地文件读取。".to_string());
    }

    let base = if path.starts_with('/') {
        Vec::new()
    } else {
        package_path
            .rsplit_once('/')
            .map(|(directory, _)| directory.split('/').map(str::to_string).collect())
            .unwrap_or_default()
    };
    let resolved = resolve_path_segments(base, path.trim_start_matches('/'))?;
    if resolved.is_empty() {
        return Err("EPUB 目录链接解析后为空。".to_string());
    }
    Ok(resolved.join("/"))
}

fn resolve_content_href(base_document_path: &str, href: &str) -> Result<ChapterTarget, String> {
    if href.contains('\\') {
        return Err("链接包含不支持的反斜杠".to_string());
    }
    if href.starts_with("//") {
        return Err("链接指向外部地址".to_string());
    }

    let (before_fragment, raw_fragment) = href
        .split_once('#')
        .map(|(before, fragment)| (before, Some(fragment)))
        .unwrap_or((href, None));
    let path = before_fragment.split('?').next().unwrap_or_default();
    let resolved_path = if path.is_empty() {
        base_document_path.to_string()
    } else {
        let first_segment = path
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or_default();
        if first_segment.contains(':') {
            return Err("链接指向外部地址".to_string());
        }
        let base = if path.starts_with('/') {
            Vec::new()
        } else {
            base_document_path
                .rsplit_once('/')
                .map(|(directory, _)| directory.split('/').map(str::to_string).collect())
                .unwrap_or_default()
        };
        let resolved = resolve_path_segments(base, path.trim_start_matches('/'))?;
        if resolved.is_empty() {
            return Err("链接解析后没有文件路径".to_string());
        }
        resolved.join("/")
    };
    let fragment = raw_fragment
        .filter(|fragment| !fragment.is_empty())
        .map(decode_uri_component)
        .transpose()?;

    Ok(ChapterTarget {
        path: resolved_path,
        fragment,
    })
}

fn decode_uri_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("锚点包含不完整的百分号编码".to_string());
            }
            let high = hex_value(bytes[index + 1])
                .ok_or_else(|| "锚点包含无效的百分号编码".to_string())?;
            let low = hex_value(bytes[index + 2])
                .ok_or_else(|| "锚点包含无效的百分号编码".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "锚点不是有效的 UTF-8".to_string())
}

fn resolve_path_segments(mut base: Vec<String>, path: &str) -> Result<Vec<String>, String> {
    for raw_segment in path.split('/') {
        let segment = decode_uri_segment(raw_segment)?;
        match segment.as_str() {
            "" | "." => {}
            ".." => {
                if base.pop().is_none() {
                    return Err("EPUB 内部路径越过了压缩包根目录。".to_string());
                }
            }
            _ if segment.contains('/') || segment.contains('\\') || segment.contains('\0') => {
                return Err("EPUB 路径包含无效的编码分隔符。".to_string());
            }
            _ => base.push(segment),
        }
    }
    Ok(base)
}

fn decode_uri_segment(segment: &str) -> Result<String, String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("EPUB 路径包含不完整的百分号编码。".to_string());
            }
            let high = hex_value(bytes[index + 1])
                .ok_or_else(|| "EPUB 路径包含无效的百分号编码。".to_string())?;
            let low = hex_value(bytes[index + 2])
                .ok_or_else(|| "EPUB 路径包含无效的百分号编码。".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "EPUB 路径不是有效的 UTF-8。".to_string())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn epub_with_navigation(nav: &str, ncx: Option<&str>) -> ZipArchive<Cursor<Vec<u8>>> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut cursor);
            let options = SimpleFileOptions::default();
            let container = r#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
            let package = format!(
                r#"<?xml version="1.0"?><package><metadata><title>Test</title></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>{}</manifest><spine{}/></package>"#,
                if ncx.is_some() {
                    r#"<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#
                } else {
                    ""
                },
                if ncx.is_some() { r#" toc="ncx""# } else { "" },
            );
            for (name, content) in [
                ("META-INF/container.xml", container),
                ("OEBPS/content.opf", package.as_str()),
                ("OEBPS/nav.xhtml", nav),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            if let Some(ncx) = ncx {
                writer.start_file("OEBPS/toc.ncx", options).unwrap();
                writer.write_all(ncx.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.set_position(0);
        ZipArchive::new(cursor).unwrap()
    }

    #[test]
    fn imports_valid_epub3_navigation() {
        let nav = r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#start">第一章</a><ol><li><a href="chapter.xhtml#section">小节</a></li></ol></li></ol></nav></body></html>"#;
        let mut archive = epub_with_navigation(nav, None);
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 2);
        assert_eq!(nodes[0].label, "第一章");
        assert_eq!(nodes[0].children[0].label, "小节");
        assert_eq!(
            nodes[0].target.as_ref().unwrap().path,
            "OEBPS/chapter.xhtml"
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn repairs_common_entities_only_when_needed() {
        let nav = r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="a.xhtml?x=1&y=2">甲&nbsp;乙 & 丙</a></li></ol></nav></body></html>"#;
        let mut archive = epub_with_navigation(nav, None);
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 1);
        assert_eq!(nodes[0].label, "甲 乙 & 丙");
        assert!(warnings.iter().any(|warning| warning.contains("XML 实体")));
    }

    #[test]
    fn entity_repair_leaves_cdata_and_comments_untouched() {
        let xml = "<!-- &nbsp; --><nav title='A & B'><![CDATA[&nbsp;]]>甲&nbsp;乙</nav>";
        let repaired = repair_common_xml_entities(xml).unwrap();
        assert_eq!(
            repaired,
            "<!-- &nbsp; --><nav title='A &amp; B'><![CDATA[&nbsp;]]>甲&#160;乙</nav>"
        );
    }

    #[test]
    fn falls_back_to_ncx_when_epub3_nav_is_broken() {
        let ncx = r#"<ncx><navMap><navPoint><navLabel><text>备用章节</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>"#;
        let mut archive = epub_with_navigation("<html><nav>", Some(ncx));
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 1);
        assert_eq!(nodes[0].label, "备用章节");
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("已改用 NCX")));
    }

    #[test]
    fn falls_back_when_nav_has_labels_but_no_links() {
        let nav = r#"<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><span>只有标题</span></li></ol></nav></body></html>"#;
        let ncx = r#"<ncx><navMap><navPoint><navLabel><text>可跳转章节</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>"#;
        let mut archive = epub_with_navigation(nav, Some(ncx));
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 1);
        assert_eq!(nodes[0].label, "可跳转章节");
        assert!(warnings.first().unwrap().contains("已改用 NCX"));
    }

    #[test]
    fn chooses_toc_after_landmarks_with_legacy_epub_namespace() {
        let nav = r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2011/epub"><body><nav epub:type="landmarks"><ol><li><a href="nav.xhtml">Table of Contents</a></li><li><a href="cover.xhtml">Cover</a></li></ol></nav><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">第一章</a><ol><li><a href="chapter1.xhtml#one">1.1 小节</a><ol><li><a href="chapter1.xhtml#detail">1.1.1 细节</a></li></ol></li></ol></li><li><a href="chapter2.xhtml">第二章</a></li></ol></nav></body></html>"#;
        let mut archive = epub_with_navigation(nav, None);
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 4);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].label, "第一章");
        assert_eq!(nodes[0].children[0].children[0].label, "1.1.1 细节");
        assert!(warnings.iter().any(|warning| warning.contains("旧版")));
    }

    #[test]
    fn uses_ncx_instead_of_an_unknown_typed_landmarks_list() {
        let nav = r#"<html xmlns:epub="urn:unknown"><body><nav epub:type="landmarks"><ol><li><a href="cover.xhtml">Cover</a></li></ol></nav><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Unrecognized</a></li></ol></nav></body></html>"#;
        let ncx = r#"<ncx><navMap><navPoint><navLabel><text>NCX 章节</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>"#;
        let mut archive = epub_with_navigation(nav, Some(ncx));
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 1);
        assert_eq!(nodes[0].label, "NCX 章节");
        assert!(warnings.first().unwrap().contains("已改用 NCX"));
    }

    #[test]
    fn reads_internal_dtd_entity_without_external_resolution() {
        let nav = r#"<!DOCTYPE html [<!ENTITY chapter "章节">]><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一&chapter;</a></li></ol></nav></body></html>"#;
        let mut archive = epub_with_navigation(nav, None);
        let (_, nodes, count, _) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 1);
        assert_eq!(nodes[0].label, "第一章节");
    }

    #[test]
    fn repairs_ncx_entities_after_nav_failure() {
        let ncx = r#"<ncx><navMap><navPoint><navLabel><text>备用&nbsp;章节 & 后记</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>"#;
        let mut archive = epub_with_navigation("<html><nav>", Some(ncx));
        let (_, nodes, count, warnings) = read_epub_navigation(&mut archive).unwrap();
        assert_eq!(count, 1);
        assert_eq!(nodes[0].label, "备用 章节 & 后记");
        assert!(warnings.first().unwrap().contains("已改用 NCX"));
        assert!(warnings.iter().any(|warning| warning.contains("XML 实体")));
    }

    #[test]
    fn reports_both_navigation_errors_when_both_fail() {
        let mut archive = epub_with_navigation("<html><nav>", Some("<ncx>"));
        let error = match read_epub_navigation(&mut archive) {
            Ok(_) => panic!("broken navigation should fail"),
            Err(error) => error,
        };
        assert!(error.contains("OEBPS/nav.xhtml"));
        assert!(error.contains("NCX 回退也失败"));
        assert!(error.contains("OEBPS/toc.ncx"));
    }

    #[test]
    #[ignore = "set SEAMIND_EPUB_SAMPLE and SEAMIND_EPUB_EXPECTED_TOC_COUNT to check a local book"]
    fn imports_configured_epub_sample() {
        let path = std::env::var("SEAMIND_EPUB_SAMPLE").expect("sample EPUB path");
        let expected_count = std::env::var("SEAMIND_EPUB_EXPECTED_TOC_COUNT")
            .expect("expected TOC count")
            .parse::<usize>()
            .expect("numeric TOC count");
        let outline = import_epub_toc(path).expect("sample EPUB should import");
        assert_eq!(outline.chapter_count, expected_count);
        assert!(outline.markdown.lines().any(|line| line.starts_with("- ")));
        assert!(outline.markdown.lines().any(|line| line.starts_with("  - ")));
        assert!(outline.markdown.lines().any(|line| line.starts_with("    - ")));
        assert!(outline.markdown.contains("seamind:epub-href="));
    }
}
