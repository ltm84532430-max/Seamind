use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBibEntry {
    pub cite_key: String,
    pub entry_type: String, // article, inproceedings, book, etc.
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>, // journal or booktitle
    pub volume: Option<String>,
    pub number: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub eprint: Option<String>,
    pub abstract_text: Option<String>,
    pub keywords: Vec<String>,
    pub raw_fields: HashMap<String, String>,
}

/// Generates a standardized JabRef-style citation key: `[firstAuthorLastName][year][firstSignificantTitleWord]`
/// Example: "Vaswani", 2017, "Attention Is All You Need" -> "vaswani2017attention"
pub fn generate_cite_key(authors: &[String], year: Option<i32>, title: &str) -> String {
    let author_part = authors
        .first()
        .map(|a| extract_last_name(a).to_lowercase())
        .unwrap_or_else(|| "anon".to_string());
    let author_clean: String = author_part
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let author_final = if author_clean.is_empty() {
        "ref".to_string()
    } else {
        author_clean
    };

    let year_part = year
        .map(|y| y.to_string())
        .unwrap_or_else(|| "nd".to_string());

    // First significant word in title (ignoring articles/prepositions)
    let stop_words = [
        "a", "an", "the", "on", "in", "of", "for", "with", "at", "by", "from", "to",
    ];
    let title_word = title
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .find(|w| !w.is_empty() && !stop_words.contains(&w.as_str()))
        .unwrap_or_else(|| "paper".to_string());

    format!("{author_final}{year_part}{title_word}")
}

/// Extracts the last name from an author string ("Ashish Vaswani" -> "Vaswani", or "Vaswani, Ashish" -> "Vaswani")
pub fn extract_last_name(author_str: &str) -> String {
    let cleaned = strip_latex_curlies(author_str.trim());
    if let Some((last, _)) = cleaned.split_once(',') {
        return last.trim().to_string();
    }
    let parts: Vec<&str> = cleaned.split_whitespace().collect();
    if let Some(last) = parts.last() {
        last.to_string()
    } else {
        cleaned
    }
}

/// Splits "Author A and Author B and Author C" into individual names
pub fn parse_authors(authors_raw: &str) -> Vec<String> {
    authors_raw
        .split(" and ")
        .map(|a| strip_latex_curlies(a.trim()))
        .filter(|a| !a.is_empty())
        .collect()
}

/// Strips braces like `{}` frequently found in BibTeX strings, e.g. `{BERT}` -> `BERT`
pub fn strip_latex_curlies(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' || c == '}' || c == '"' {
            continue;
        }
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if next == '&' || next == '%' || next == '$' || next == '#' || next == '_' {
                    result.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        result.push(c);
    }
    result.trim().to_string()
}

/// Parses a BibTeX string into a list of `ParsedBibEntry`
pub fn parse_bibtex(content: &str) -> Vec<ParsedBibEntry> {
    let mut entries = Vec::new();
    let mut chars = content.chars().peekable();

    while let Some(c) = chars.next() {
        if c != '@' {
            continue;
        }

        // Read entry type (e.g. "article")
        let mut entry_type = String::new();
        while let Some(&ch) = chars.peek() {
            if ch.is_alphanumeric() || ch == '_' || ch == '-' {
                entry_type.push(chars.next().unwrap());
            } else {
                break;
            }
        }
        let entry_type = entry_type.trim().to_lowercase();
        if entry_type.is_empty() || entry_type == "comment" || entry_type == "preamble" {
            continue;
        }

        // Consume whitespace until opening delimiter '{' or '('
        skip_whitespace(&mut chars);
        let delimiter_close = match chars.next() {
            Some('{') => '}',
            Some('(') => ')',
            _ => continue,
        };

        // Read cite_key up to ','
        let mut cite_key = String::new();
        while let Some(&ch) = chars.peek() {
            if ch == ',' || ch == delimiter_close {
                break;
            }
            cite_key.push(chars.next().unwrap());
        }
        let cite_key = cite_key.trim().to_string();

        if chars.peek() == Some(&',') {
            chars.next(); // skip ','
        }

        // Parse key-value pairs
        let mut fields: HashMap<String, String> = HashMap::new();
        while let Some(&ch) = chars.peek() {
            if ch == delimiter_close {
                chars.next(); // end of entry
                break;
            }

            skip_whitespace_and_commas(&mut chars);
            if chars.peek() == Some(&delimiter_close) {
                chars.next();
                break;
            }

            // Read field name
            let mut field_name = String::new();
            while let Some(&kch) = chars.peek() {
                if kch.is_alphanumeric() || kch == '_' || kch == '-' {
                    field_name.push(chars.next().unwrap());
                } else {
                    break;
                }
            }
            let field_name = field_name.trim().to_lowercase();
            if field_name.is_empty() {
                // If not empty, advance one char to avoid infinite loop
                chars.next();
                continue;
            }

            skip_whitespace(&mut chars);
            if chars.peek() != Some(&'=') {
                continue;
            }
            chars.next(); // consume '='
            skip_whitespace(&mut chars);

            // Read field value
            let val = read_field_value(&mut chars);
            fields.insert(field_name, val);

            skip_whitespace_and_commas(&mut chars);
        }

        let title = fields
            .get("title")
            .map(|s| strip_latex_curlies(s))
            .unwrap_or_default();
        let authors = fields
            .get("author")
            .or_else(|| fields.get("authors"))
            .map(|s| parse_authors(s))
            .unwrap_or_default();
        let year = fields
            .get("year")
            .and_then(|y| y.trim().parse::<i32>().ok());
        let venue = fields
            .get("journal")
            .or_else(|| fields.get("booktitle"))
            .map(|v| strip_latex_curlies(v));
        let volume = fields.get("volume").map(|s| strip_latex_curlies(s));
        let number = fields
            .get("number")
            .or_else(|| fields.get("issue"))
            .map(|s| strip_latex_curlies(s));
        let pages = fields.get("pages").map(|s| strip_latex_curlies(s));
        let publisher = fields.get("publisher").map(|s| strip_latex_curlies(s));
        let doi = fields.get("doi").map(|s| clean_doi(s));
        let url = fields.get("url").map(|s| strip_latex_curlies(s));
        let eprint = fields
            .get("eprint")
            .or_else(|| fields.get("arxivid"))
            .map(|s| strip_latex_curlies(s));
        let abstract_text = fields.get("abstract").map(|s| strip_latex_curlies(s));
        let keywords = fields
            .get("keywords")
            .map(|kw| {
                kw.split(|c| c == ',' || c == ';')
                    .map(|k| strip_latex_curlies(k.trim()))
                    .filter(|k| !k.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let final_cite_key = if cite_key.is_empty() {
            generate_cite_key(&authors, year, &title)
        } else {
            cite_key
        };

        entries.push(ParsedBibEntry {
            cite_key: final_cite_key,
            entry_type,
            title,
            authors,
            year,
            venue,
            volume,
            number,
            pages,
            publisher,
            doi,
            url,
            eprint,
            abstract_text,
            keywords,
            raw_fields: fields,
        });
    }

    entries
}

fn skip_whitespace(chars: &mut std::iter::Peekable<std::str::Chars>) {
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }
}

fn skip_whitespace_and_commas(chars: &mut std::iter::Peekable<std::str::Chars>) {
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() || c == ',' {
            chars.next();
        } else {
            break;
        }
    }
}

fn read_field_value(chars: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut value = String::new();
    match chars.peek() {
        Some('{') => {
            chars.next(); // consume opening {
            let mut depth = 1;
            while let Some(c) = chars.next() {
                if c == '{' {
                    depth += 1;
                    value.push(c);
                } else if c == '}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    value.push(c);
                } else {
                    value.push(c);
                }
            }
        }
        Some('"') => {
            chars.next(); // consume opening "
            let mut escaped = false;
            while let Some(c) = chars.next() {
                if escaped {
                    value.push(c);
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    break;
                } else {
                    value.push(c);
                }
            }
        }
        _ => {
            // Unquoted number or string literal until comma or close brace
            while let Some(&c) = chars.peek() {
                if c == ',' || c == '}' || c == ')' || c == '\n' || c == '\r' {
                    break;
                }
                value.push(chars.next().unwrap());
            }
        }
    }
    value.trim().to_string()
}

pub fn clean_doi(input: &str) -> String {
    let stripped = strip_latex_curlies(input);
    let trimmed = stripped.trim();
    if let Some(pos) = trimmed.find("10.") {
        trimmed[pos..].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Serializes a `ParsedBibEntry` to a standard BibTeX string
pub fn serialize_bibtex(entry: &ParsedBibEntry) -> String {
    let entry_type = if entry.entry_type.is_empty() {
        "article"
    } else {
        &entry.entry_type
    };

    let mut out = format!("@{}{{{},\n", entry_type, entry.cite_key);

    if !entry.title.is_empty() {
        out.push_str(&format!("  title = {{{}}},\n", entry.title));
    }
    if !entry.authors.is_empty() {
        out.push_str(&format!(
            "  author = {{{}}},\n",
            entry.authors.join(" and ")
        ));
    }
    if let Some(ref venue) = entry.venue {
        if entry_type == "inproceedings" || entry_type == "incollection" {
            out.push_str(&format!("  booktitle = {{{}}},\n", venue));
        } else {
            out.push_str(&format!("  journal = {{{}}},\n", venue));
        }
    }
    if let Some(year) = entry.year {
        out.push_str(&format!("  year = {{{}}},\n", year));
    }
    if let Some(ref volume) = entry.volume {
        out.push_str(&format!("  volume = {{{}}},\n", volume));
    }
    if let Some(ref number) = entry.number {
        out.push_str(&format!("  number = {{{}}},\n", number));
    }
    if let Some(ref pages) = entry.pages {
        out.push_str(&format!("  pages = {{{}}},\n", pages));
    }
    if let Some(ref publisher) = entry.publisher {
        out.push_str(&format!("  publisher = {{{}}},\n", publisher));
    }
    if let Some(ref doi) = entry.doi {
        out.push_str(&format!("  doi = {{{}}},\n", doi));
    }
    if let Some(ref url) = entry.url {
        out.push_str(&format!("  url = {{{}}},\n", url));
    }
    if let Some(ref eprint) = entry.eprint {
        out.push_str(&format!("  eprint = {{{}}},\n", eprint));
    }
    if !entry.keywords.is_empty() {
        out.push_str(&format!(
            "  keywords = {{{}}},\n",
            entry.keywords.join(", ")
        ));
    }
    if let Some(ref abs) = entry.abstract_text {
        if !abs.is_empty() {
            out.push_str(&format!("  abstract = {{{}}},\n", abs));
        }
    }

    out.push_str("}\n");
    out
}

/// Formats into an APA citation string:
/// "Vaswani, A., Shazeer, N., et al. (2017). Attention is all you need. NeurIPS, 30."
#[allow(dead_code)]
pub fn format_apa(entry: &ParsedBibEntry) -> String {
    let author_str = if entry.authors.is_empty() {
        "Anonymous".to_string()
    } else if entry.authors.len() == 1 {
        format_author_initials(&entry.authors[0])
    } else if entry.authors.len() == 2 {
        format!(
            "{} & {}",
            format_author_initials(&entry.authors[0]),
            format_author_initials(&entry.authors[1])
        )
    } else {
        format!("{} et al.", format_author_initials(&entry.authors[0]))
    };

    let year_str = entry
        .year
        .map(|y| format!("({y})"))
        .unwrap_or_else(|| "(n.d.)".to_string());

    let mut result = format!(
        "{author_str} {year_str}. {}.",
        entry.title.trim_end_matches('.')
    );

    if let Some(ref venue) = entry.venue {
        result.push_str(&format!(" {venue}"));
        if let Some(ref vol) = entry.volume {
            result.push_str(&format!(", {vol}"));
        }
        if let Some(ref pages) = entry.pages {
            result.push_str(&format!(", {pages}"));
        }
        result.push('.');
    }

    if let Some(ref doi) = entry.doi {
        result.push_str(&format!(" https://doi.org/{doi}"));
    }

    result
}

/// Formats into an IEEE citation string:
/// "[1] A. Vaswani et al., "Attention is all you need," NeurIPS, vol. 30, 2017."
#[allow(dead_code)]
pub fn format_ieee(entry: &ParsedBibEntry) -> String {
    let author_str = if entry.authors.is_empty() {
        "Anonymous".to_string()
    } else if entry.authors.len() <= 2 {
        entry
            .authors
            .iter()
            .map(|a| format_author_initials(a))
            .collect::<Vec<_>>()
            .join(" and ")
    } else {
        format!("{} et al.", format_author_initials(&entry.authors[0]))
    };

    let mut result = format!("{author_str}, \"{},\"", entry.title.trim_end_matches('.'));

    if let Some(ref venue) = entry.venue {
        result.push_str(&format!(" {venue},"));
    }
    if let Some(ref vol) = entry.volume {
        result.push_str(&format!(" vol. {vol},"));
    }
    if let Some(ref pages) = entry.pages {
        result.push_str(&format!(" pp. {pages},"));
    }
    if let Some(year) = entry.year {
        result.push_str(&format!(" {year}."));
    } else {
        result.push('.');
    }

    result
}

fn format_author_initials(author: &str) -> String {
    let cleaned = strip_latex_curlies(author.trim());
    if let Some((last, first)) = cleaned.split_once(',') {
        let initials: String = first
            .split_whitespace()
            .filter_map(|w| w.chars().next().map(|c| format!("{c}.")))
            .collect::<Vec<_>>()
            .join(" ");
        if initials.is_empty() {
            last.trim().to_string()
        } else {
            format!("{}, {initials}", last.trim())
        }
    } else {
        let parts: Vec<&str> = cleaned.split_whitespace().collect();
        if parts.len() <= 1 {
            cleaned
        } else {
            let last = parts.last().unwrap();
            let initials: String = parts[..parts.len() - 1]
                .iter()
                .filter_map(|w| w.chars().next().map(|c| format!("{c}.")))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{last}, {initials}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_and_serialize_bibtex() {
        let bib = r#"
@article{vaswani2017attention,
  author = {Ashish Vaswani and Noam Shazeer and Niki Parmar},
  title = {Attention Is All You Need},
  journal = {Advances in Neural Information Processing Systems},
  year = {2017},
  volume = {30},
  doi = {10.48550/arXiv.1706.03762}
}
"#;
        let entries = parse_bibtex(bib);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.cite_key, "vaswani2017attention");
        assert_eq!(entry.title, "Attention Is All You Need");
        assert_eq!(entry.year, Some(2017));
        assert_eq!(entry.authors.len(), 3);
        assert_eq!(entry.doi, Some("10.48550/arXiv.1706.03762".to_string()));

        let serialized = serialize_bibtex(entry);
        assert!(serialized.contains("@article{vaswani2017attention"));
        assert!(serialized.contains("title = {Attention Is All You Need}"));

        let apa = format_apa(entry);
        assert!(apa.contains("Vaswani, A. et al. (2017)"));
        assert!(apa.contains("Attention Is All You Need"));
    }

    #[test]
    fn test_cite_key_generation() {
        let authors = vec!["Ashish Vaswani".to_string(), "Noam Shazeer".to_string()];
        let key = generate_cite_key(&authors, Some(2017), "Attention Is All You Need");
        assert_eq!(key, "vaswani2017attention");
    }
}
