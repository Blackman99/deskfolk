//! A small XML tree for the Office parts: element names without their prefix (`w:p` is `p`), the
//! attributes likewise (but `r:id` stays `r:id`, so it never meets a plain `id`), the text of an
//! element joined. Enough for every part the previews read; a namespace never has to be told apart
//! because a part belongs to one format.

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

#[derive(Debug, Default, Clone)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// An attribute read as a number.
    pub fn num(&self, name: &str) -> Option<f64> {
        self.attr(name).and_then(|v| v.trim().parse().ok())
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn kids<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// The first descendant (depth first) named `name`.
    pub fn find(&self, name: &str) -> Option<&Node> {
        for c in &self.children {
            if c.name == name {
                return Some(c);
            }
            if let Some(found) = c.find(name) {
                return Some(found);
            }
        }
        None
    }

}

fn local(raw: &str) -> String {
    match raw.rsplit_once(':') {
        Some((_, tail)) => tail.to_string(),
        None => raw.to_string(),
    }
}

fn element(start: &BytesStart) -> Node {
    let mut node = Node { name: local(start.name().as_ref()), ..Node::default() };
    for attr in start.attributes().flatten() {
        let raw = attr.key.as_ref();
        let key = if raw.starts_with("r:") { raw.to_string() } else { local(raw) };
        if key == "xmlns" || raw.starts_with("xmlns:") {
            continue;
        }
        let value = attr.normalized_value(quick_xml::XmlVersion::Implicit1_0).map(|v| v.into_owned()).unwrap_or_default();
        node.attrs.push((key, value));
    }
    node
}

fn reference(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            let digits = name.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// Deepest nesting read: a part nested deeper than a real document ever is, is refused.
const MAX_DEPTH: usize = 200;

pub fn parse(bytes: &[u8]) -> Result<Node, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut stack: Vec<Node> = vec![Node { name: "#root".into(), ..Node::default() }];
    loop {
        match reader.read_event().map_err(|e| format!("not valid XML: {e}"))? {
            Event::Start(start) => {
                if stack.len() > MAX_DEPTH {
                    return Err("XML nested too deeply".into());
                }
                stack.push(element(&start));
            }
            Event::Empty(start) => {
                let node = element(&start);
                stack.last_mut().expect("root").children.push(node);
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err("unbalanced XML".into());
                }
                let node = stack.pop().expect("checked");
                stack.last_mut().expect("root").children.push(node);
            }
            Event::Text(text) => {
                stack.last_mut().expect("root").text.push_str(&text.xml10_content());
            }
            Event::CData(data) => {
                stack.last_mut().expect("root").text.push_str(&data);
            }
            Event::GeneralRef(name) => {
                if let Some(c) = reference(&name) {
                    stack.last_mut().expect("root").text.push(c);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("XML ends inside an element".into());
    }
    let root = stack.pop().expect("root");
    root.children.into_iter().next().ok_or_else(|| "empty XML".to_string())
}
