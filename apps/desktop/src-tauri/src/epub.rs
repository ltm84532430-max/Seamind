use std::{
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
const MAX_MARKDOWN_BYTES: usize = 1_048_576;
const DC_NAMESPACE: &str = "http://purl.org/dc/elements/1.1/";
const EPUB_NAMESPACE: &str = "http://www.idpf.org/2007/ops";
const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubOutline {
    title: String,
    markdown: String,
    chapter_count: usize,
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

struct OutlineNode {
    label: String,
    children: Vec<OutlineNode>,
}

#[tauri::command]
pub fn import_epub_toc(path: String) -> Result<EpubOutline, String> {
    let path = Path::new(path.trim());
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

    let mut archive =
        ZipArchive::new(file).map_err(|_| "文件不是有效的 EPUB/ZIP 压缩包。".to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("EPUB 包含过多文件条目，已停止解析。".to_string());
    }

    let container_xml = read_zip_xml(&mut archive, "META-INF/container.xml")?;
    let package_path = parse_container(&container_xml)?;
    drop(container_xml);

    let package_xml = read_zip_xml(&mut archive, &package_path)?;
    let package = parse_package(&package_xml)?;
    drop(package_xml);

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

    let (nodes, chapter_count) = if let Some(nav_href) = package.nav_href {
        let nav_path = resolve_package_href(&package_path, &nav_href)?;
        let nav_xml = read_zip_xml(&mut archive, &nav_path)?;
        parse_epub3_nav(&nav_xml)?
    } else if let Some(ncx_href) = package.ncx_href {
        let ncx_path = resolve_package_href(&package_path, &ncx_href)?;
        let ncx_xml = read_zip_xml(&mut archive, &ncx_path)?;
        parse_epub2_ncx(&ncx_xml)?
    } else {
        return Err("这本书没有可用的 EPUB 目录（EPUB 3 nav 或 EPUB 2 NCX）。".to_string());
    };

    if nodes.is_empty() || chapter_count == 0 {
        return Err("没有在 EPUB 目录中找到可导入的章节。".to_string());
    }

    let markdown = outline_to_markdown(&title, &nodes)?;
    Ok(EpubOutline {
        title,
        markdown,
        chapter_count,
        source_file,
    })
}

fn read_zip_xml<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str) -> Result<String, String> {
    let entry = archive
        .by_name(name)
        .map_err(|_| format!("EPUB 中缺少目录文件：{name}"))?;
    if entry.is_dir() || entry.size() > MAX_XML_BYTES {
        return Err(format!("EPUB 目录文件过大或无效：{name}"));
    }

    let mut bytes = Vec::with_capacity(entry.size().min(MAX_XML_BYTES) as usize);
    entry
        .take(MAX_XML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("无法读取 EPUB 目录文件：{name}"))?;
    if bytes.len() as u64 > MAX_XML_BYTES {
        return Err(format!("EPUB 目录文件解压后超过 8 MB：{name}"));
    }
    decode_xml(&bytes).map_err(|_| format!("EPUB 目录文件不是有效的 UTF-8/UTF-16 XML：{name}"))
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
    Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: MAX_XML_NODES,
            ..ParsingOptions::default()
        },
    )
    .map_err(|_| format!("{description}不是有效或受支持的 XML。"))
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

fn parse_epub3_nav(xml: &str) -> Result<(Vec<OutlineNode>, usize), String> {
    let document = parse_xml(xml, "EPUB 3 导航文件")?;
    let toc_nav = document
        .descendants()
        .find(|node| {
            node.is_element()
                && node.tag_name().name() == "nav"
                && node
                    .attribute((EPUB_NAMESPACE, "type"))
                    .is_some_and(|value| value.split_whitespace().any(|token| token == "toc"))
        })
        .or_else(|| {
            document.descendants().find(|node| {
                has_local_name(*node, "nav")
                    && node.attribute((EPUB_NAMESPACE, "type")).is_none()
                    && node.children().any(|child| has_local_name(child, "ol"))
            })
        })
        .ok_or_else(|| "EPUB 3 导航文件中没有目录列表。".to_string())?;
    let list = toc_nav
        .children()
        .find(|node| has_local_name(*node, "ol"))
        .ok_or_else(|| "EPUB 3 目录中没有 ol 列表。".to_string())?;
    let mut count = 0;
    let nodes = parse_html_list(list, 1, &mut count)?;
    Ok((nodes, count))
}

fn parse_html_list(
    list: Node<'_, '_>,
    depth: usize,
    count: &mut usize,
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
            children.extend(parse_html_list(child_list, depth + 1, count)?);
        }
        if label.is_empty() {
            nodes.extend(children);
            continue;
        }
        register_toc_entry(count)?;
        nodes.push(OutlineNode { label, children });
    }
    Ok(nodes)
}

fn parse_epub2_ncx(xml: &str) -> Result<(Vec<OutlineNode>, usize), String> {
    let document = parse_xml(xml, "EPUB 2 NCX 目录文件")?;
    let nav_map = document
        .descendants()
        .find(|node| has_local_name(*node, "navMap"))
        .ok_or_else(|| "EPUB 2 NCX 文件中没有 navMap。".to_string())?;
    let mut count = 0;
    let nodes = parse_ncx_points(nav_map, 1, &mut count)?;
    Ok((nodes, count))
}

fn parse_ncx_points(
    parent: Node<'_, '_>,
    depth: usize,
    count: &mut usize,
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
        let children = parse_ncx_points(point, depth + 1, count)?;
        if label.is_empty() {
            nodes.extend(children);
            continue;
        }
        register_toc_entry(count)?;
        nodes.push(OutlineNode { label, children });
    }
    Ok(nodes)
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
        markdown.push('\n');
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err("生成的目录内容超过 1 MB，无法导入。".to_string());
        }
        append_markdown_nodes(&node.children, depth + 1, markdown)?;
    }
    Ok(())
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
