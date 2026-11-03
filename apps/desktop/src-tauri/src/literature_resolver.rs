//! Resolve a paper to a public PDF without trusting arbitrary redirects or HTML.
use regex::Regex;
use reqwest::{header::LOCATION, redirect::Policy, Client, Response};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use url::Url;

const MAX_HTML: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub url: Url,
    pub source: &'static str,
    pub version: Option<String>,
    pub license: Option<String>,
}

fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || b == 0 || (b == 0 && c == 2)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}

fn public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_ipv4(v4);
    }
    let s = ip.segments();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (s[0] & 0xe000) != 0x2000
        || s[0] == 0x2002
        || (s[0] == 0x2001 && s[1] == 0)
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] == 0x2001 && s[1] == 0x0db8))
}

// Some VPNs return 198.18/15 synthetic addresses from the system resolver.
// Resolve those hostnames independently over TLS, then pin only public answers.
async fn public_dns(host: &str) -> Result<Vec<SocketAddr>, String> {
    let address: SocketAddr = "1.1.1.1:443".parse().unwrap();
    let client = Client::builder().no_proxy().redirect(Policy::none())
        .resolve("cloudflare-dns.com", address).connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8)).build().map_err(|_| "无法创建 DNS 连接")?;
    for record_type in ["A", "AAAA"] {
        let response = client.get("https://cloudflare-dns.com/dns-query")
            .header("accept", "application/dns-json")
            .query(&[("name", host), ("type", record_type)])
            .send().await.map_err(|_| "无法安全解析全文地址")?;
        let bytes = read_small(response).await?;
        let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "DNS 响应无效")?;
        if json.get("Status").and_then(|v| v.as_i64()) != Some(0) { return Err("无法安全解析全文地址".into()); }
        let ips: Vec<IpAddr> = json.get("Answer").and_then(|v| v.as_array()).into_iter().flatten()
            .filter_map(|item| item.get("data").and_then(|v| v.as_str()).and_then(|v| v.parse::<IpAddr>().ok()))
            .collect();
        if ips.iter().any(|ip| !public_ip(*ip)) { return Err("全文地址包含不可访问的网络地址".into()); }
        if !ips.is_empty() { return Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, 443)).collect()); }
    }
    Err("无法安全解析全文地址".into())
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_ipv4(ip),
        IpAddr::V6(ip) => public_ipv6(ip),
    }
}

/// All candidate URLs, including each redirect, must be public HTTPS. Pin the
/// resolved addresses in the direct client so DNS cannot change after checking.
pub fn safe_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "全文链接格式无效".to_string())?;
    if url.scheme() == "http" {
        url.set_scheme("https").map_err(|_| "全文链接协议无效")?;
    }
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return Err("全文链接不符合安全访问条件".into());
    }
    match url.host().ok_or("全文链接没有主机名")? {
        url::Host::Ipv4(ip) if !public_ipv4(ip) => return Err("全文链接指向本地网络".into()),
        url::Host::Ipv6(ip) if !public_ipv6(ip) => return Err("全文链接指向本地网络".into()),
        _ => {}
    }
    let host = url
        .host_str()
        .ok_or("全文链接没有主机名")?
        .trim_end_matches('.')
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err("全文链接指向本地网络".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err("全文链接指向本地网络".into());
        }
    }
    url.set_fragment(None);
    Ok(url)
}

pub async fn request(raw: &str) -> Result<(Response, Url), String> {
    let mut url = safe_url(raw)?;
    for _ in 0..=MAX_REDIRECTS {
        let host = url
            .host_str()
            .ok_or("全文链接没有主机名")?
            .trim_matches(['[', ']'])
            .to_string();
        let addresses: Vec<SocketAddr> = tokio::time::timeout(
            Duration::from_secs(8),
            tokio::net::lookup_host((host.as_str(), 443)),
        )
        .await
        .map_err(|_| "解析全文地址超时".to_string())?
        .map_err(|_| "无法解析全文地址，请检查网络".to_string())?
        .collect();
        let addresses = if addresses.is_empty() || addresses.iter().any(|addr| !public_ip(addr.ip())) {
            public_dns(&host).await?
        } else { addresses };
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(&host, &addresses)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(120))
            .read_timeout(Duration::from_secs(35))
            .user_agent("Seamind-Desktop/0.1 (academic paper reader)")
            .build()
            .map_err(|_| "无法创建网络连接".to_string())?;
        let response = client.get(url.clone()).send().await.map_err(|e| {
            if e.is_timeout() {
                "连接全文来源超时".to_string()
            } else {
                "无法连接全文来源，请检查网络".to_string()
            }
        })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("全文跳转地址无效")?;
            let target = url.join(location).map_err(|_| "全文跳转地址无效")?;
            url = safe_url(target.as_str())?;
            continue;
        }
        return Ok((response, url));
    }
    Err("全文链接跳转次数过多".into())
}

async fn read_small(mut response: Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("来源返回 HTTP {}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_HTML as u64)
    {
        return Err("来源页面过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取来源页面失败")? {
        if bytes.len() + chunk.len() > MAX_HTML {
            return Err("来源页面过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_entities(value: &str) -> String {
    let re = Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|amp|quot|apos|lt|gt);").unwrap();
    re.replace_all(value, |c: &regex::Captures<'_>| match &c[1] {
        "amp" => "&".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        n => {
            let (digits, base) = if let Some(s) = n.strip_prefix("#x") {
                (s, 16)
            } else {
                (&n[1..], 10)
            };
            u32::from_str_radix(digits, base)
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| c[0].to_string())
        }
    })
    .into_owned()
}

/// Extract bounded meta/link attributes without executing publisher HTML.
fn html_metadata(html: &str) -> Vec<(String, String)> {
    let tags = Regex::new(r"(?is)<(?:meta|link)\b[^>]{0,8192}>").unwrap();
    let attrs = Regex::new(r#"(?is)([a-z_:][a-z0-9_:\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap();
    let mut out = Vec::new();
    for tag in tags.find_iter(html).take(512) {
        let fields: Vec<(String, String)> = attrs
            .captures_iter(tag.as_str())
            .map(|c| {
                (
                    c[1].to_ascii_lowercase(),
                    decode_entities(
                        c.get(2)
                            .or_else(|| c.get(3))
                            .map(|m| m.as_str())
                            .unwrap_or(""),
                    ),
                )
            })
            .collect();
        let field = |key: &str| {
            fields
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        if let (Some(name), Some(value)) = (
            field("name").or_else(|| field("property")),
            field("content"),
        ) {
            out.push((name.to_ascii_lowercase(), value.to_string()));
        } else if field("type").is_some_and(|v| v.eq_ignore_ascii_case("application/pdf")) {
            if let Some(href) = field("href") {
                out.push(("citation_pdf_url".into(), href.to_string()));
            }
        }
    }
    out
}

fn normalize_doi(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("doi:")
        .trim()
        .to_ascii_lowercase()
}

pub fn arxiv_id(value: &str) -> Option<String> {
    let mut id = value
        .trim()
        .trim_start_matches("https://arxiv.org/abs/")
        .trim_start_matches("http://arxiv.org/abs/")
        .trim_start_matches("https://arxiv.org/pdf/")
        .trim_start_matches("http://arxiv.org/pdf/")
        .trim_start_matches("arXiv:")
        .trim_start_matches("arxiv:");
    if id.to_ascii_lowercase().starts_with("10.48550/arxiv.") {
        id = &id[15..];
    }
    id = id.trim_end_matches(".pdf");
    static ARXIV_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = ARXIV_RE.get_or_init(|| Regex::new(r"(?i)^(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]+/\d{7})(?:v\d+)?$").unwrap());
    re.is_match(id).then(|| id.to_string())
}

pub async fn candidates(
    doi: Option<&str>,
    arxiv: Option<&str>,
    supplied_url: Option<&str>,
    email: Option<&str>,
) -> Vec<Candidate> {
    let mut out = Vec::new();
    let id = arxiv
        .and_then(arxiv_id)
        .or_else(|| doi.and_then(arxiv_id))
        .or_else(|| supplied_url.and_then(arxiv_id));
    if let Some(id) = id {
        if let Ok(url) = safe_url(&format!("https://arxiv.org/pdf/{id}")) {
            out.push(Candidate {
                url,
                source: "arXiv",
                version: Some(id),
                license: None,
            });
        }
    }
    if let Some(doi) = doi
        .map(normalize_doi)
        .filter(|s| s.starts_with("10.") && s.contains('/'))
    {
        let encoded = url::form_urlencoded::byte_serialize(doi.as_bytes()).collect::<String>();
        if let Ok((response, _)) =
            request(&format!("https://api.crossref.org/works/{encoded}")).await
        {
            if let Ok(bytes) = read_small(response).await {
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    let message = &json["message"];
                    if normalize_doi(message.get("DOI").and_then(|v| v.as_str()).unwrap_or(""))
                        == doi
                    {
                        if let Some(links) = message.get("link").and_then(|v| v.as_array()) {
                            for link in links.iter().take(5) {
                                let pdf = link
                                    .get("content-type")
                                    .and_then(|v| v.as_str())
                                    .is_some_and(|v| v.eq_ignore_ascii_case("application/pdf"));
                                let use_case = link
                                    .get("intended-application")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unspecified");
                                if pdf && use_case == "unspecified" {
                                    if let Some(url) = link
                                        .get("URL")
                                        .and_then(|v| v.as_str())
                                        .and_then(|v| safe_url(v).ok())
                                    {
                                        out.push(Candidate {
                                            url,
                                            source: "Crossref",
                                            version: link
                                                .get("content-version")
                                                .and_then(|v| v.as_str())
                                                .map(str::to_owned),
                                            license: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let doi_url = format!("https://doi.org/{doi}");
        if let Ok((response, landing)) = request(&doi_url).await {
            if let Ok(bytes) = read_small(response).await {
                let html = String::from_utf8_lossy(&bytes);
                let meta = html_metadata(&html);
                // Bind the PDF to the requested DOI; an unrelated redirect must not attach another paper.
                if meta
                    .iter()
                    .any(|(key, value)| key == "citation_doi" && normalize_doi(value) == doi)
                {
                    for (_, value) in meta
                        .iter()
                        .filter(|(key, _)| key == "citation_pdf_url")
                        .take(3)
                    {
                        if let Ok(url) = landing.join(value).and_then(|u| {
                            safe_url(u.as_str())
                                .map_err(|_| url::ParseError::RelativeUrlWithoutBase)
                        }) {
                            out.push(Candidate {
                                url,
                                source: "出版社",
                                version: None,
                                license: None,
                            });
                        }
                    }
                }
            }
        }
        if let Some(email) = email
            .map(str::trim)
            .filter(|s| s.contains('@') && s.len() <= 254 && !s.chars().any(char::is_whitespace))
        {
            if let Ok(mut url) = Url::parse(&format!("https://api.unpaywall.org/v2/{doi}")) {
                url.query_pairs_mut().append_pair("email", email);
                if let Ok((response, _)) = request(url.as_str()).await {
                    if let Ok(bytes) = read_small(response).await {
                        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            if normalize_doi(json.get("doi").and_then(|v| v.as_str()).unwrap_or(""))
                                == doi
                            {
                                let location = &json["best_oa_location"];
                                if let Some(url) = location
                                    .get("url_for_pdf")
                                    .and_then(|v| v.as_str())
                                    .and_then(|s| safe_url(s).ok())
                                {
                                    out.push(Candidate {
                                        url,
                                        source: "Unpaywall",
                                        version: location
                                            .get("version")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_owned),
                                        license: location
                                            .get("license")
                                            .and_then(|v| v.as_str())
                                            .map(str::to_owned),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_addresses_and_credentials() {
        for url in [
            "http://localhost/a",
            "https://127.0.0.1/a",
            "https://192.168.1.1/a",
            "https://[::1]/a",
            "https://user@example.com/a",
            "file:///tmp/a",
        ] {
            assert!(safe_url(url).is_err(), "{url}");
        }
        assert!(safe_url("http://example.com/a")
            .unwrap()
            .as_str()
            .starts_with("https://"));
        assert!(!public_ip("198.18.0.56".parse().unwrap()));
        assert!(!public_ip("2002:7f00:1::1".parse().unwrap()));
    }
    #[test]
    fn extracts_publisher_metadata_in_any_attribute_order() {
        let items = html_metadata(
            r#"<meta content='10.1/abc' name='citation_doi'><META content='/paper.pdf?x=1&amp;y=2' name='citation_pdf_url'>"#,
        );
        assert!(items.contains(&("citation_doi".into(), "10.1/abc".into())));
        assert!(items.contains(&("citation_pdf_url".into(), "/paper.pdf?x=1&y=2".into())));
    }
    #[test]
    fn accepts_arxiv_ids_and_rejects_arbitrary_paths() {
        assert_eq!(
            arxiv_id("10.48550/arXiv.1706.03762"),
            Some("1706.03762".into())
        );
        assert_eq!(
            arxiv_id("https://arxiv.org/pdf/1706.03762v7.pdf"),
            Some("1706.03762v7".into())
        );
        assert_eq!(arxiv_id("../../secret"), None);
    }
    #[tokio::test]
    #[ignore = "requires live external sources"]
    async fn resolves_the_two_reported_papers() {
        let (response, _) = request("https://arxiv.org/pdf/1706.03762").await.unwrap();
        assert!(response.status().is_success());
        let bytes = response.bytes().await.unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes[bytes.len() - 2048..]
            .windows(5)
            .any(|v| v == b"%%EOF"));
        let found = candidates(Some("10.37155/2717-5170-0612-27"), None, None, None).await;
        let publisher = found
            .iter()
            .find(|item| item.source == "出版社")
            .expect("DOI landing page must expose its PDF");
        let (response, _) = request(publisher.url.as_str()).await.unwrap();
        assert!(response.status().is_success());
        let bytes = response.bytes().await.unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes[bytes.len() - 2048..]
            .windows(5)
            .any(|v| v == b"%%EOF"));
    }
}
