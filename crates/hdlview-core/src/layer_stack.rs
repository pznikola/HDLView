//! KLayout 2.5D scripts (`.lyd25`): which GDS layers form each material of the
//! process stack, between which heights, and in which colour. Only the subset
//! the PDK scripts use is read: `input` layers, variables, `|`, `&` and `-`,
//! `z` and `zz` with their keyword arguments. Any other statement is an error,
//! so a stack the reader cannot follow is reported rather than drawn wrong.

use anyhow::{bail, Context, Result};
use roxmltree::Document;
use std::collections::HashMap;
use std::path::Path;

/// A set of shapes derived from GDS layers with the script's operators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    Input(u16, u16),
    Or(Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    /// Left without right.
    Diff(Box<Expr>, Box<Expr>),
}
/// Shapes extruded between two heights in µm.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub expr: Expr,
    pub zstart: f64,
    pub zstop: f64,
}
/// A `z` call, or a `zz` block holding several, shown as one entry.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Material {
    pub name: Option<String>,
    /// `#rrggbb`
    pub fill: Option<String>,
    /// The layer whose layer-file style the material borrows.
    pub like: Option<(u16, u16)>,
    pub parts: Vec<Part>,
}

pub fn read(path: &Path) -> Result<Vec<Material>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    parse(&text).with_context(|| format!("reading 2.5D script {}", path.display()))
}

/// The materials of a `.lyd25` macro file, in script order.
pub fn parse(text: &str) -> Result<Vec<Material>> {
    let document = Document::parse(text)?;
    let script = document
        .root_element()
        .children()
        .find(|node| node.has_tag_name("text"))
        .and_then(|node| node.text())
        .context("the macro has no <text> script")?;
    let mut materials = Vec::new();
    let mut names: HashMap<String, Expr> = HashMap::new();
    // An omitted zstart continues from the previous z call, across zz blocks too.
    let mut current_z = 0.0;
    let mut group: Option<Material> = None;
    for (index, line) in script.lines().enumerate() {
        let context = || format!("line {}: {}", index + 1, line.trim());
        let tokens = tokens(line).with_context(context)?;
        if tokens.is_empty() {
            continue;
        }
        let mut parser = Parser {
            tokens: &tokens,
            at: 0,
        };
        (|| -> Result<()> {
            match &tokens[..] {
                [Token::Ident(name), Token::Punct('='), ..] => {
                    parser.at = 2;
                    let expr = parser.expr(&names)?;
                    parser.finish()?;
                    names.insert(name.clone(), expr);
                }
                [Token::Ident(call), Token::Punct('('), ..] if call == "z" => {
                    parser.at = 2;
                    let expr = parser.expr(&names)?;
                    let mut height = None;
                    let mut arguments = Vec::new();
                    while parser.take(&Token::Punct(',')) {
                        match parser.peek() {
                            Some(Token::Number(_)) => height = Some(parser.number()?),
                            _ => arguments.push(parser.argument()?),
                        }
                    }
                    parser.expect(&Token::Punct(')'))?;
                    parser.finish()?;
                    let mut material = Material::default();
                    let mut zstart = None;
                    let mut zstop = None;
                    for (key, value) in arguments {
                        match (key.as_str(), value) {
                            ("zstart", Value::Number(v)) => zstart = Some(v),
                            ("zstop", Value::Number(v)) => zstop = Some(v),
                            ("height", Value::Number(v)) => height = Some(v),
                            (key, value) => material.display(key, value)?,
                        }
                    }
                    let zstart = zstart.unwrap_or(current_z);
                    // Heights add up in µm; keep them to a picometre so sums stay tidy.
                    let zstop = match (zstop, height) {
                        (Some(zstop), None) => zstop,
                        (None, Some(height)) => ((zstart + height) * 1e6).round() / 1e6,
                        _ => bail!("z needs exactly one of height and zstop"),
                    };
                    current_z = zstop;
                    let part = Part {
                        expr,
                        zstart,
                        zstop,
                    };
                    match &mut group {
                        Some(group) => group.parts.push(part),
                        None => {
                            material.parts.push(part);
                            materials.push(material);
                        }
                    }
                }
                [Token::Ident(call), Token::Punct('('), ..] if call == "zz" => {
                    if group.is_some() {
                        bail!("zz blocks cannot nest");
                    }
                    parser.at = 2;
                    let mut material = Material::default();
                    if !parser.take(&Token::Punct(')')) {
                        loop {
                            let (key, value) = parser.argument()?;
                            material.display(&key, value)?;
                            if !parser.take(&Token::Punct(',')) {
                                break;
                            }
                        }
                        parser.expect(&Token::Punct(')'))?;
                    }
                    parser.expect(&Token::Ident("do".into()))?;
                    parser.finish()?;
                    group = Some(material);
                }
                [Token::Ident(word)] if word == "end" => match group.take() {
                    Some(material) => materials.push(material),
                    None => bail!("end without a zz block"),
                },
                _ => bail!("unsupported 2.5D statement"),
            }
            Ok(())
        })()
        .with_context(context)?;
    }
    if group.is_some() {
        bail!("a zz block is not closed with end");
    }
    Ok(materials)
}

impl Material {
    /// A display argument of `z` or `zz`; `frame` is accepted and ignored since
    /// the view draws no edges.
    fn display(&mut self, key: &str, value: Value) -> Result<()> {
        match (key, value) {
            ("name", Value::Str(name)) => self.name = Some(name),
            ("color" | "fill", Value::Number(rgb)) => {
                self.fill = Some(format!("#{:06x}", rgb as u32))
            }
            ("color" | "fill" | "frame", Value::Str(colour)) => {
                if key != "frame" {
                    self.fill = Some(colour);
                }
            }
            ("frame", Value::Number(_)) => {}
            ("like", Value::Str(source)) => {
                self.like = Some(
                    crate::layer_properties::pair(&source)
                        .with_context(|| format!("like: {source:?} is not a layer/datatype"))?,
                )
            }
            (key, _) => bail!("unsupported argument {key}"),
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Ident(String),
    /// Heights in µm (`.nm` and `.um` suffixes applied), colours as their value.
    Number(f64),
    Str(String),
    Punct(char),
}
#[derive(Debug, Clone, PartialEq)]
enum Value {
    Number(f64),
    Str(String),
}

fn tokens(line: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '#' {
            break;
        }
        if c.is_whitespace() {
            i += 1;
        } else if c == '"' {
            let end = chars[i + 1..]
                .iter()
                .position(|&c| c == '"')
                .map(|p| i + 1 + p)
                .context("unterminated string")?;
            out.push(Token::Str(chars[i + 1..end].iter().collect()));
            i = end + 1;
        } else if c.is_ascii_digit() {
            let start = i;
            if c == '0' && chars.get(i + 1) == Some(&'x') {
                i += 2;
                while i < chars.len() && chars[i].is_ascii_hexdigit() {
                    i += 1;
                }
                let digits: String = chars[start + 2..i].iter().collect();
                out.push(Token::Number(u32::from_str_radix(&digits, 16)? as f64));
                continue;
            }
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if chars.get(i) == Some(&'.') && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let value: f64 = chars[start..i].iter().collect::<String>().parse()?;
            let scale = if chars.get(i) == Some(&'.') {
                let unit: String = chars[i + 1..]
                    .iter()
                    .take_while(|c| c.is_ascii_alphabetic())
                    .collect();
                i += unit.len() + 1;
                match unit.as_str() {
                    "nm" => 0.001,
                    "um" | "micron" => 1.0,
                    _ => bail!("unknown unit .{unit}"),
                }
            } else {
                1.0
            };
            out.push(Token::Number(value * scale));
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(Token::Ident(chars[start..i].iter().collect()));
        } else if "(),=|&-:".contains(c) {
            out.push(Token::Punct(c));
            i += 1;
        } else {
            bail!("unexpected character {c:?}");
        }
    }
    Ok(out)
}

struct Parser<'a> {
    tokens: &'a [Token],
    at: usize,
}
impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a Token> {
        self.tokens.get(self.at)
    }
    fn take(&mut self, token: &Token) -> bool {
        let found = self.peek() == Some(token);
        if found {
            self.at += 1;
        }
        found
    }
    fn expect(&mut self, token: &Token) -> Result<()> {
        if !self.take(token) {
            bail!("expected {token:?}, found {:?}", self.peek());
        }
        Ok(())
    }
    fn finish(&self) -> Result<()> {
        match self.peek() {
            None => Ok(()),
            Some(token) => bail!("unexpected {token:?}"),
        }
    }
    /// A number with an optional sign.
    fn number(&mut self) -> Result<f64> {
        let negative = self.take(&Token::Punct('-'));
        match self.peek() {
            Some(Token::Number(value)) => {
                self.at += 1;
                Ok(if negative { -value } else { *value })
            }
            other => bail!("expected a number, found {other:?}"),
        }
    }
    /// `key: value`
    fn argument(&mut self) -> Result<(String, Value)> {
        let key = match self.peek() {
            Some(Token::Ident(key)) => key.clone(),
            other => bail!("expected an argument name, found {other:?}"),
        };
        self.at += 1;
        self.expect(&Token::Punct(':'))?;
        let value = match self.peek() {
            Some(Token::Str(text)) => {
                self.at += 1;
                Value::Str(text.clone())
            }
            _ => Value::Number(self.number()?),
        };
        Ok((key, value))
    }
    // Ruby's precedence: `-` binds tighter than `&`, which binds tighter than `|`.
    fn expr(&mut self, names: &HashMap<String, Expr>) -> Result<Expr> {
        let mut left = self.and(names)?;
        while self.take(&Token::Punct('|')) {
            left = Expr::Or(Box::new(left), Box::new(self.and(names)?));
        }
        Ok(left)
    }
    fn and(&mut self, names: &HashMap<String, Expr>) -> Result<Expr> {
        let mut left = self.diff(names)?;
        while self.take(&Token::Punct('&')) {
            left = Expr::And(Box::new(left), Box::new(self.diff(names)?));
        }
        Ok(left)
    }
    fn diff(&mut self, names: &HashMap<String, Expr>) -> Result<Expr> {
        let mut left = self.atom(names)?;
        while self.take(&Token::Punct('-')) {
            left = Expr::Diff(Box::new(left), Box::new(self.atom(names)?));
        }
        Ok(left)
    }
    fn atom(&mut self, names: &HashMap<String, Expr>) -> Result<Expr> {
        match self.peek().cloned() {
            Some(Token::Punct('(')) => {
                self.at += 1;
                let inner = self.expr(names)?;
                self.expect(&Token::Punct(')'))?;
                Ok(inner)
            }
            Some(Token::Ident(name)) if name == "input" => {
                self.at += 1;
                self.expect(&Token::Punct('('))?;
                let layer = self.layer_number()?;
                let datatype = if self.take(&Token::Punct(',')) {
                    self.layer_number()?
                } else {
                    0
                };
                self.expect(&Token::Punct(')'))?;
                Ok(Expr::Input(layer, datatype))
            }
            Some(Token::Ident(name)) => {
                self.at += 1;
                names
                    .get(&name)
                    .cloned()
                    .with_context(|| format!("unknown layer {name}"))
            }
            other => bail!("expected a layer, found {other:?}"),
        }
    }
    fn layer_number(&mut self) -> Result<u16> {
        match self.peek() {
            Some(Token::Number(value))
                if value.fract() == 0.0 && (0.0..=65535.0).contains(value) =>
            {
                self.at += 1;
                Ok(*value as u16)
            }
            other => bail!("expected a layer number, found {other:?}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn macro_file(script: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<klayout-macro>\n <interpreter>dsl</interpreter>\n <text>{script}</text>\n</klayout-macro>"
        )
    }
    fn input(layer: u16, datatype: u16) -> Box<Expr> {
        Box::new(Expr::Input(layer, datatype))
    }
    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn the_constructs_of_the_pdk_scripts_are_read() {
        let materials = parse(&macro_file(
            r#"# Stack definition
poly = input(66, 20)
licon = input(66, 44)
nSD = input(7)
sal = input(28,0)
res  = input(128,0)
gat = input(5,0) | res
rhigh = sal &amp; nSD - poly # sal &amp; (nSD - poly)

z(poly, zstart: -100.nm, height: 250.nm, name: "poly")
zz(name: "licon", like: "66/44") do
  over = licon &amp; poly
  z(over, zstart: 250.nm, height: 400.nm)
  z(licon - over, zstart: 0.nm, height: 650.nm)
end
z(gat, height: 0.2, color: 0xff8000, frame: 0x000000)
z((rhigh), 0.14)
"#,
        ))
        .unwrap();
        assert_eq!(materials.len(), 4);
        assert_eq!(materials[0].name.as_deref(), Some("poly"));
        assert_eq!(materials[0].parts[0].expr, Expr::Input(66, 20));
        assert!(near(materials[0].parts[0].zstart, -0.1));
        assert!(near(materials[0].parts[0].zstop, 0.15));
        let licon = &materials[1];
        assert_eq!(licon.name.as_deref(), Some("licon"));
        assert_eq!(licon.like, Some((66, 44)));
        assert_eq!(licon.parts.len(), 2);
        assert_eq!(licon.parts[0].expr, Expr::And(input(66, 44), input(66, 20)));
        assert!(near(licon.parts[0].zstart, 0.25) && near(licon.parts[0].zstop, 0.65));
        assert_eq!(
            licon.parts[1].expr,
            Expr::Diff(
                input(66, 44),
                Box::new(Expr::And(input(66, 44), input(66, 20)))
            )
        );
        assert!(near(licon.parts[1].zstart, 0.0) && near(licon.parts[1].zstop, 0.65));
        // Without zstart a material continues from the previous z call, across the block.
        let gat = &materials[2];
        assert_eq!(gat.name, None);
        assert_eq!(gat.fill.as_deref(), Some("#ff8000"));
        assert_eq!(gat.parts[0].expr, Expr::Or(input(5, 0), input(128, 0)));
        assert!(near(gat.parts[0].zstart, 0.65) && near(gat.parts[0].zstop, 0.85));
        let rhigh = &materials[3];
        assert_eq!(
            rhigh.parts[0].expr,
            Expr::And(
                input(28, 0),
                Box::new(Expr::Diff(input(7, 0), input(66, 20)))
            )
        );
        assert!(near(rhigh.parts[0].zstart, 0.85) && near(rhigh.parts[0].zstop, 0.99));
    }

    #[test]
    fn scripts_outside_the_subset_are_errors_naming_the_line() {
        let error = |script: &str| format!("{:#}", parse(&macro_file(script)).unwrap_err());
        assert!(error("poly = input(66, 20)\nz(poly)")
            .contains("line 2: z(poly): z needs exactly one of height and zstop"));
        assert!(error("poly = input(66, 20)\nz(poly, height: 1, zstop: 2)")
            .contains("exactly one of height"));
        assert!(error("z(foo, height: 1)").contains("line 1: z(foo, height: 1): unknown layer foo"));
        assert!(error("poly = input(66, 20)\nx = poly - 10.mm")
            .contains("line 2: x = poly - 10.mm: unknown unit .mm"));
        assert!(error("poly = input(66, 20)\nx = poly.extents")
            .contains("line 2: x = poly.extents: unexpected character '.'"));
        assert!(error("source(\"a.gds\")").contains("unsupported 2.5D statement"));
        assert!(error("end").contains("end without a zz block"));
        assert!(error("zz(name: \"a\") do").contains("a zz block is not closed"));
        assert!(error("poly = input(66, 20)\nz(poly, height: 1, hollow: 1)")
            .contains("unsupported argument hollow"));
        assert!(
            error("poly = input(66, 20)\nz(poly, height: 1, like: \"metal\")")
                .contains("not a layer/datatype")
        );
        assert!(error("poly = input(66, 20)\nz(poly, height: 1 # comment")
            .contains("expected Punct(')')"));
        assert!(
            error("<text>").contains("has no <text> script") || parse("<klayout-macro/>").is_err()
        );
    }

    #[test]
    fn a_file_is_read_with_its_path_in_errors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("stack.lyd25");
        std::fs::write(&path, macro_file("m = input(1)\nz(m, 1.5)")).unwrap();
        let materials = read(&path).unwrap();
        assert_eq!(materials[0].parts[0].expr, Expr::Input(1, 0));
        assert!(near(materials[0].parts[0].zstop, 1.5));
        std::fs::write(&path, macro_file("z(input(1), zstop: 1, height: 2)")).unwrap();
        assert!(format!("{:#}", read(&path).unwrap_err()).contains("stack.lyd25: line 1"));
        assert!(format!("{:#}", read(&temp.path().join("none")).unwrap_err()).contains("reading"));
    }
}
