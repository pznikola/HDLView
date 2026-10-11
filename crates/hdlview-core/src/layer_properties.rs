//! KLayout layer properties files (`.lyp`): the name, colours and fill pattern
//! each GDS layer is shown with. Only what the view draws is read: brightness,
//! transparency, line styles, frame widths, animation and group inheritance
//! are not reproduced.

use anyhow::{Context, Result};
use roxmltree::{Document, Node};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerStyle {
    pub layer: u16,
    pub datatype: u16,
    pub name: String,
    /// `#rrggbb`
    pub fill: String,
    pub frame: String,
    /// Rows of the fill bitmap, top row first; `*` is a set pixel.
    pub pattern: Vec<String>,
    /// Shown when first opened: the file's `visible` and `valid` flags.
    pub visible: bool,
}

/// KLayout's built-in fill patterns `I0` to `I46`, top row first.
const BUILTIN_PATTERNS: [&[&str]; 47] = [
    &["*"],
    &["."],
    &["*.", ".*"],
    &["*...", "....", "..*.", "...."],
    &["*...", ".*..", "..*.", "...*"],
    &[
        "*.......", ".*......", "..*.....", "...*....", "....*...", ".....*..", "......*.",
        ".......*",
    ],
    &["**..", ".**.", "..**", "*..*"],
    &[
        "**......", ".**.....", "..**....", "...**...", "....**..", ".....**.", "......**",
        "*......*",
    ],
    &["*...", "...*", "..*.", ".*.."],
    &[
        "*.......", ".......*", "......*.", ".....*..", "....*...", "...*....", "..*.....",
        ".*......",
    ],
    &["**..", "*..*", "..**", ".**."],
    &[
        "**......", "*......*", "......**", ".....**.", "....**..", "...**...", "..**....",
        ".**.....",
    ],
    &["*...", ".*.*", "..*.", ".*.*"],
    &[
        "*.......", ".*.....*", "..*...*.", "...*.*..", "....*...", "...*.*..", "..*...*.",
        ".*.....*",
    ],
    &["**..", "**..", "..**", "..**"],
    &[
        "**......", "***....*", "..**..**", "...****.", "....**..", "...****.", "..**..**",
        "***....*",
    ],
    &[
        "****....", "****....", "****....", "****....", "....****", "....****", "....****",
        "....****",
    ],
    &[
        ".*...*..", "*.*.....", ".*...*..", "....*.*.", ".*...*..", "*.*.....", ".*...*..",
        "....*.*.",
    ],
    &[
        ".*...*..", "***.....", ".*...*..", "....***.", ".*...*..", "***.....", ".*...*..",
        "....***.",
    ],
    &[
        ".*......", "*.*.....", "****...*", "........", "....*...", "...*.*..", "..*****.",
        "........",
    ],
    &[
        "****...*", "*.*.....", ".*......", "........", "..*****.", "...*.*..", "....*...",
        "........",
    ],
    &[
        "..*...*.", "..*.....", "*****...", "..*.....", "..*...*.", "......*.", "*...****",
        "......*.",
    ],
    &[
        "........", "........", "*****...", "........", "........", "........", "*...****",
        "........",
    ],
    &[
        "*......*", ".**.....", "...**...", ".....**.", "*......*", ".**.....", "...**...",
        ".....**.",
    ],
    &[
        "*......*", ".....**.", "...**...", ".**.....", "*......*", ".....**.", "...**...",
        ".**.....",
    ],
    &[
        "*...*...", ".*...*..", ".*...*..", "..*...*.", "..*...*.", "...*...*", "...*...*",
        "*...*...",
    ],
    &[
        "...*...*", "..*...*.", "..*...*.", ".*...*..", ".*...*..", "*...*...", "*...*...",
        "...*...*",
    ],
    &[
        "*......*", ".**..**.", "...**...", ".**..**.", "*......*", ".**..**.", "...**...",
        ".**..**.",
    ],
    &[
        "..*...*.", ".*.*.*.*", "*...*...", "........", "..*...*.", ".*.*.*.*", "*...*...",
        "........",
    ],
    &[
        "..***...", ".*...*..", "*.....**", "........", "..***...", ".*...*..", "*.....**",
        "........",
    ],
    &[
        "****.*.*", "**.****.", "*.**.***", "*****.*.", ".**.****", "**.***.*", ".****.**",
        "*.*.****",
    ],
    &[
        "....*.*.", "..*....*", ".*..*...", ".....*.*", "*..*....", "..*...*.", "*....*..",
        ".*.*....",
    ],
    &["*.", "*."],
    &[".*..", ".*..", ".*..", ".*.."],
    &[".**.", ".**.", ".**.", ".**."],
    &["...*....", "...*....", "...*....", "...*...."],
    &["...**...", "...**...", "...**...", "...**..."],
    &["**", ".."],
    &["....", "****", "....", "...."],
    &["....", "****", "****", "...."],
    &[
        "........", "........", "........", "********", "........", "........", "........",
        "........",
    ],
    &[
        "........", "........", "........", "********", "********", "........", "........",
        "........",
    ],
    &["**", "*."],
    &[".*..", "****", ".*..", ".*.."],
    &[".**.", "****", "****", ".**."],
    &[
        "...*....", "...*....", "...*....", "********", "...*....", "...*....", "...*....",
        "...*....",
    ],
    &[
        "...**...", "...**...", "...**...", "********", "********", "...**...", "...**...",
        "...**...",
    ],
];
/// KLayout's colour for a layer without one: entry `layer % 36` of its palette.
const PALETTE: [&str; 36] = [
    "#ff9d9d", "#ff80a8", "#c080ff", "#9580ff", "#8086ff", "#80a8ff", "#ff0000", "#ff0080",
    "#ff00ff", "#8000ff", "#0000ff", "#0080ff", "#800000", "#800057", "#800080", "#500080",
    "#000080", "#004080", "#80fffb", "#80ff8d", "#afff80", "#f3ff80", "#ffc280", "#ffa080",
    "#00ffff", "#01ff6b", "#91ff00", "#ddff00", "#ffae00", "#ff8000", "#008080", "#008050",
    "#008000", "#508000", "#808000", "#805000",
];
/// A layer without a pattern alternates lightly right- and left-hatched by position.
fn default_pattern(leaf: usize) -> Vec<String> {
    builtin(if leaf.is_multiple_of(2) { 9 } else { 5 })
}
fn builtin(number: usize) -> Vec<String> {
    BUILTIN_PATTERNS[number.min(BUILTIN_PATTERNS.len() - 1)]
        .iter()
        .map(|row| row.to_string())
        .collect()
}
fn default_colour(layer: u16) -> String {
    PALETTE[layer as usize % PALETTE.len()].to_string()
}

/// The style of a GDS layer the file does not list, at position `leaf` of the list.
pub fn default_style(layer: u16, datatype: u16, leaf: usize) -> LayerStyle {
    LayerStyle {
        layer,
        datatype,
        name: format!("{layer}/{datatype}"),
        fill: default_colour(layer),
        frame: default_colour(layer),
        pattern: default_pattern(leaf),
        visible: true,
    }
}

/// The file's layer entries in its order; entries whose source is not a
/// `layer/datatype` pair (wildcards, named layers) are left out.
pub fn read(path: &Path) -> Result<Vec<LayerStyle>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    parse(&text).with_context(|| format!("reading layer file {}", path.display()))
}

fn parse(text: &str) -> Result<Vec<LayerStyle>> {
    let document = Document::parse(text)?;
    let root = document.root_element();
    fn field<'a>(node: Node<'a, 'a>, name: &str) -> Option<&'a str> {
        node.children()
            .find(|child| child.has_tag_name(name))
            .and_then(|child| child.text())
    }
    // `C<k>` names the k-th custom pattern in file order; `<order>` is only its position in a menu.
    let custom: Vec<Vec<String>> = root
        .children()
        .filter(|node| node.has_tag_name("custom-dither-pattern"))
        .map(|node| {
            node.children()
                .find(|child| child.has_tag_name("pattern"))
                .map(|pattern| {
                    pattern
                        .children()
                        .filter(|line| line.has_tag_name("line"))
                        .map(|line| line.text().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    let mut styles = Vec::new();
    let mut leaves = Vec::new();
    for entry in root
        .children()
        .filter(|node| node.has_tag_name("properties"))
    {
        collect_leaves(entry, &mut leaves);
    }
    for (leaf, node) in leaves.into_iter().enumerate() {
        let source = field(node, "source").unwrap_or_default();
        let Some((layer, datatype)) = pair(source) else {
            continue;
        };
        let colour = |name: &str| match field(node, name) {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => default_colour(layer),
        };
        let pattern = match field(node, "dither-pattern").unwrap_or_default() {
            "" => default_pattern(leaf),
            value => {
                let (kind, number) = value.split_at(1);
                let number: usize = number
                    .parse()
                    .with_context(|| format!("unknown pattern {value} of {source}"))?;
                match kind {
                    "I" => builtin(number),
                    "C" => custom.get(number).cloned().with_context(|| {
                        format!("{source} uses pattern {value}, which the file does not define")
                    })?,
                    _ => anyhow::bail!("unknown pattern {value} of {source}"),
                }
            }
        };
        styles.push(LayerStyle {
            layer,
            datatype,
            name: field(node, "name")
                .filter(|name| !name.is_empty())
                .unwrap_or(source)
                .to_string(),
            fill: colour("fill-color"),
            frame: colour("frame-color"),
            pattern,
            visible: field(node, "visible") != Some("false")
                && field(node, "valid") != Some("false"),
        });
    }
    Ok(styles)
}
/// An entry, or the entries of its group, in file order.
fn collect_leaves<'a>(node: Node<'a, 'a>, leaves: &mut Vec<Node<'a, 'a>>) {
    let groups: Vec<Node> = node
        .children()
        .filter(|child| child.has_tag_name("group-members"))
        .collect();
    if groups.is_empty() {
        leaves.push(node);
    } else {
        for group in groups {
            collect_leaves(group, leaves);
        }
    }
}
/// `layer/datatype`, with an optional `@cellview` suffix.
pub(crate) fn pair(source: &str) -> Option<(u16, u16)> {
    let (layer, datatype) = source.split('@').next()?.split_once('/')?;
    Some((layer.trim().parse().ok()?, datatype.trim().parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<layer-properties>
 <properties>
  <frame-color>#ff0000</frame-color>
  <fill-color>#00ff00</fill-color>
  <dither-pattern>C1</dither-pattern>
  <valid>true</valid>
  <visible>true</visible>
  <name>met1.drawing - 68/20</name>
  <source>68/20@1</source>
 </properties>
 <properties>
  <frame-color>#0000ff</frame-color>
  <fill-color>#0000ff</fill-color>
  <dither-pattern>I1</dither-pattern>
  <visible>false</visible>
  <name>met1.pin</name>
  <source>68/16@1</source>
 </properties>
 <properties>
  <fill-color>#123456</fill-color>
  <valid>false</valid>
  <name>stale</name>
  <source>99/0@1</source>
 </properties>
 <properties>
  <name>everything</name>
  <source>*/*@*</source>
 </properties>
 <properties>
  <name>group</name>
  <source>*/*@1</source>
  <group-members>
   <dither-pattern>C0</dither-pattern>
   <name>via.drawing</name>
   <source>67/44</source>
  </group-members>
 </properties>
 <custom-dither-pattern>
  <pattern>
   <line>*.</line>
   <line>.*</line>
  </pattern>
  <order>2</order>
  <name>second in the menu</name>
 </custom-dither-pattern>
 <custom-dither-pattern>
  <pattern>
   <line>**..</line>
  </pattern>
  <order>1</order>
  <name>first in the menu</name>
 </custom-dither-pattern>
</layer-properties>"#;

    #[test]
    fn entries_keep_file_order_with_custom_patterns_numbered_by_position() {
        let styles = parse(FILE).unwrap();
        assert_eq!(
            styles,
            vec![
                LayerStyle {
                    layer: 68,
                    datatype: 20,
                    name: "met1.drawing - 68/20".into(),
                    fill: "#00ff00".into(),
                    frame: "#ff0000".into(),
                    pattern: vec!["**..".into()],
                    visible: true,
                },
                LayerStyle {
                    layer: 68,
                    datatype: 16,
                    name: "met1.pin".into(),
                    fill: "#0000ff".into(),
                    frame: "#0000ff".into(),
                    pattern: vec![".".into()],
                    visible: false,
                },
                LayerStyle {
                    layer: 99,
                    datatype: 0,
                    name: "stale".into(),
                    fill: "#123456".into(),
                    frame: "#ddff00".into(),
                    pattern: builtin(9),
                    visible: false,
                },
                LayerStyle {
                    layer: 67,
                    datatype: 44,
                    name: "via.drawing".into(),
                    fill: "#008050".into(),
                    frame: "#008050".into(),
                    pattern: vec!["*.".into(), ".*".into()],
                    visible: true,
                },
            ]
        );
        assert_eq!(default_style(70, 0, 1).fill, "#808000");
        assert_eq!(default_style(70, 0, 1).pattern, builtin(5));
        assert!(parse(&FILE.replace("C1", "C7"))
            .unwrap_err()
            .to_string()
            .contains("C7"));
        assert!(parse("<layer-properties><properties>").is_err());
    }
}
