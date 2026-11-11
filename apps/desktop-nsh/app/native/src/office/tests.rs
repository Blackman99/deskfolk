use std::io::Write;

use serde_json::Value;

use super::{Kind, model};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn open(kind: Kind, name: &str) -> Value {
    serde_json::from_str(&model(kind, fixture(name)).unwrap().0).unwrap()
}

/// A package with the given parts, as `zip` writes one.
fn package(parts: &[(&str, &str)]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    let options = zip::write::SimpleFileOptions::default();
    for (name, body) in parts {
        zip.start_file(*name, options).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    out.into_inner()
}

fn texts(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(t)) = map.get("text").filter(|_| map.get("type").is_none_or(|k| k == "text")) {
                out.push(t.clone());
            }
            if let Some(Value::String(t)) = map.get("code") {
                out.push(t.clone());
            }
            map.values().for_each(|c| texts(c, out));
        }
        Value::Array(items) => items.iter().for_each(|c| texts(c, out)),
        _ => {}
    }
}

fn all_text(v: &Value) -> String {
    let mut out = Vec::new();
    texts(v, &mut out);
    out.concat()
}

#[test]
fn the_sample_workbook_reads_as_the_messengers_model() {
    let book = open(Kind::Spreadsheet, "sample.xlsx");
    let sheets = book["sheets"].as_array().unwrap();
    assert_eq!(sheets.len(), 2);
    assert_eq!(sheets[0]["name"], "花费");
    assert_eq!(sheets[1]["name"], "第二页");
    let rows = sheets[0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 11, "a header and ten rows");
    assert_eq!(rows[0]["number"], 1);
    let header = rows[0]["cells"].as_array().unwrap();
    assert_eq!(header.len() as u64, sheets[0]["columns"].as_u64().unwrap());
    assert!(header.iter().all(|c| !c.as_str().unwrap().is_empty()));
    assert_eq!(sheets[0]["truncated"], false);
    assert!(book.get("truncated").is_none());
    // Every cell is a string, numbers as JavaScript writes them.
    assert!(rows.iter().flat_map(|r| r["cells"].as_array().unwrap()).all(Value::is_string));
    assert!(!sheets[1]["rows"].as_array().unwrap().is_empty());
}

#[test]
fn a_formula_without_a_saved_result_shows_the_formula_and_dates_read_as_days() {
    let sheet = r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="2"><c r="B2" s="1"><v>45000</v></c><c r="C2"><f>SUM(A1:A2)</f></c><c r="E2" t="b"><v>0</v></c></row>
<row r="4"><c r="A4" s="2"><v>45000.5</v></c><c r="B4" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>"#;
    let styles = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/></cellXfs></styleSheet>"#;
    let data = package(&[
        ("[Content_Types].xml", "<Types/>"),
        ("_rels/.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#),
        ("xl/workbook.xml", r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Shown" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>"#),
        ("xl/_rels/workbook.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#),
        ("xl/styles.xml", styles),
        ("xl/worksheets/sheet1.xml", sheet),
        ("xl/worksheets/sheet2.xml", sheet),
    ]);
    let book: Value = serde_json::from_str(&model(Kind::Spreadsheet, data).unwrap().0).unwrap();
    let sheets = book["sheets"].as_array().unwrap();
    assert_eq!(sheets.len(), 1, "the hidden sheet is left out");
    let rows = sheets[0]["rows"].as_array().unwrap();
    // Row 1 and row 3 hold nothing and are not listed; numbers are the worksheet's own.
    assert_eq!(rows.iter().map(|r| r["number"].as_u64().unwrap()).collect::<Vec<_>>(), [2, 4]);
    assert_eq!(sheets[0]["columns"], 5);
    assert_eq!(rows[0]["cells"], serde_json::json!(["", "2023-03-15", "=SUM(A1:A2)", "", "false"]));
    assert_eq!(rows[1]["cells"][0], "2023-03-15T12:00:00.000Z");
    assert_eq!(rows[1]["cells"][1], "#DIV/0!");
}

#[test]
fn rows_and_columns_past_the_caps_are_left_out_and_said() {
    let mut rows = String::new();
    for n in 1..=1005 {
        rows += &format!(r#"<row r="{n}"><c r="A{n}" t="inlineStr"><is><t>r{n}</t></is></c></row>"#);
    }
    rows += r#"<row r="1">"#;
    let wide: String = (0..105u32)
        .map(|i| {
            let name = if i < 26 { format!("{}", (b'A' + i as u8) as char) } else { format!("{}{}", (b'A' + (i / 26 - 1) as u8) as char, (b'A' + (i % 26) as u8) as char) };
            format!(r#"<c r="{name}2000" t="inlineStr"><is><t>w</t></is></c>"#)
        })
        .collect();
    let sheet = format!(r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{}<row r="2000">{wide}</row></sheetData></worksheet>"#, rows.trim_end_matches(r#"<row r="1">"#));
    let data = package(&[
        ("[Content_Types].xml", "<Types/>"),
        ("_rels/.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#),
        ("xl/workbook.xml", r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>"#),
        ("xl/_rels/workbook.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#),
        ("xl/worksheets/sheet1.xml", &sheet),
    ]);
    let book: Value = serde_json::from_str(&model(Kind::Spreadsheet, data).unwrap().0).unwrap();
    let big = &book["sheets"][0];
    assert_eq!(big["rows"].as_array().unwrap().len(), 1000);
    assert_eq!(big["truncated"], true);
    assert_eq!(big["columns"], 1, "the wide row was past the 1000th");
}

#[test]
fn the_sample_document_has_its_title_heading_bullets_and_table() {
    let doc = open(Kind::Word, "sample.docx");
    let blocks = doc["blocks"].as_array().unwrap();
    let kinds: Vec<&str> = blocks.iter().map(|b| b["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["heading", "paragraph", "heading", "list", "custom"]);
    assert_eq!(blocks[0]["level"], 1);
    assert_eq!(all_text(&blocks[0]), "周报草稿 Weekly draft");
    assert!(all_text(&blocks[1]).starts_with("这是一段中文正文"));
    assert_eq!(blocks[2]["level"], 1);
    assert_eq!(all_text(&blocks[2]), "一、进展");
    let list = &blocks[3];
    assert_eq!(list["ordered"], false);
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(all_text(&items[2]), "第 3 条进展");
    let table = &blocks[4];
    assert_eq!(table["name"], "table");
    let rows = table["data"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1]["cells"].as_array().unwrap().len(), 3);
    assert_eq!(all_text(&rows[2]["cells"][2]["blocks"]), "R2C2 单元");
    assert_eq!(table["data"]["widths"], serde_json::json!([144.0, 144.0, 144.0]));
}

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

#[test]
fn word_runs_links_numbering_merges_images_and_page_breaks() {
    let body = r#"
<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>Second level</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:strike/><w:color w:val="C00000"/></w:rPr><w:t>loud</w:t></w:r>
<w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>code()</w:t></w:r>
<w:hyperlink r:id="rId9"><w:r><w:t>site</w:t></w:r></w:hyperlink>
<w:r><w:br w:type="page"/></w:r><w:r><w:t>after</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>nested</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>centred</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="1" name="p" descr="a picture"/><a:graphic><a:graphicData><a:pic><a:blipFill><a:blip r:embed="rId8"/></a:blipFill></a:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>tall</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#;
    let data = package(&[
        ("[Content_Types].xml", "<Types/>"),
        ("word/document.xml", &format!("<w:document {NS}><w:body>{body}</w:body></w:document>")),
        ("word/_rels/document.xml.rels", r#"<Relationships xmlns="x"><Relationship Id="rId9" Type="t/hyperlink" Target="https://example.com/" TargetMode="External"/><Relationship Id="rId8" Type="t/image" Target="media/pic.png"/></Relationships>"#),
        ("word/styles.xml", &format!(r#"<w:styles {NS}><w:style w:styleId="2"><w:name w:val="heading 2"/></w:style></w:styles>"#)),
        ("word/numbering.xml", &format!(r#"<w:numbering {NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#)),
        ("word/media/pic.png", "PNG"),
    ]);
    let (json, pkg) = model(Kind::Word, data).unwrap();
    assert!(pkg.is_some(), "a document keeps its package for its pictures");
    let doc: Value = serde_json::from_str(&json).unwrap();
    let blocks = doc["blocks"].as_array().unwrap();
    let kinds: Vec<&str> = blocks.iter().map(|b| b["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["heading", "paragraph", "rule", "paragraph", "list", "custom", "paragraph", "custom"]);
    assert_eq!(blocks[0]["level"], 2, "a heading by its style's name, not its id");
    let line = blocks[1]["content"].as_array().unwrap();
    assert_eq!(line[0]["type"], "custom");
    assert_eq!(line[0]["data"]["color"], "#c00000");
    assert_eq!((line[0]["text"].as_str(), line[0]["data"]["bold"].as_bool(), line[0]["data"]["strike"].as_bool()), (Some("loud"), Some(true), Some(true)));
    assert_eq!(line[1], serde_json::json!({ "type": "code", "code": "code()" }));
    assert_eq!(line[2]["type"], "link");
    assert_eq!(line[2]["url"], "https://example.com/");
    assert_eq!(all_text(&blocks[3]), "after");
    let list = &blocks[4];
    assert_eq!(list["ordered"], true);
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let nested = &items[0]["children"][1];
    assert_eq!((nested["type"].as_str(), nested["ordered"].as_bool()), (Some("list"), Some(false)));
    assert_eq!(blocks[5]["name"], "aligned");
    assert_eq!(blocks[5]["data"]["align"], "center");
    let picture = &blocks[6]["content"][0];
    assert_eq!(picture["src"], "office-image:word/media/pic.png");
    assert_eq!((picture["width"].as_f64(), picture["height"].as_f64(), picture["alt"].as_str()), (Some(100.0), Some(50.0), Some("a picture")));
    let rows = blocks[7]["data"]["rows"].as_array().unwrap();
    assert_eq!(rows[0]["cells"][0]["span"], 2);
    assert_eq!(rows[1]["cells"][0]["merge"], "restart");
    assert_eq!(rows[2]["cells"][0]["merge"], "continue");
}

#[test]
fn the_sample_deck_has_two_slides_with_placeholder_frames_from_the_layout_and_master() {
    let deck = open(Kind::Presentation, "sample.pptx");
    assert_eq!((deck["width"].as_f64(), deck["height"].as_f64()), (Some(720.0), Some(540.0)));
    let slides = deck["slides"].as_array().unwrap();
    assert_eq!(slides.len(), 2);
    let text = |s: &Value| -> Vec<String> {
        s["shapes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sh| sh["text"]["paragraphs"].as_array().unwrap().iter().map(|p| p["runs"].as_array().unwrap().iter().map(|r| r["text"].as_str().unwrap()).collect::<String>()).collect::<Vec<_>>().join("|"))
            .collect()
    };
    assert_eq!(text(&slides[0]), ["季度回顾", "Deskfolk · 2026"]);
    assert_eq!(text(&slides[1]), ["要点", "第一点|第二点|Third point"]);
    for slide in slides {
        for shape in slide["shapes"].as_array().unwrap() {
            assert!(shape["w"].as_f64().unwrap() > 0.0 && shape["h"].as_f64().unwrap() > 0.0, "{shape}");
        }
    }
    // The title of slide 2 is the master's: 457200 x 274638 EMU, anchored in the middle, 44 pt.
    let title = &slides[1]["shapes"][0];
    assert_eq!((title["x"].as_f64(), title["y"].as_f64(), title["w"].as_f64()), (Some(36.0), Some(21.63), Some(648.0)));
    assert_eq!(title["text"]["anchor"], "ctr");
    assert_eq!(title["text"]["paragraphs"][0]["runs"][0]["size"], 44.0);
    // The body's lines come with the master's bullets and size.
    let body = &slides[1]["shapes"][1];
    assert_eq!(body["text"]["paragraphs"][0]["bullet"], "•");
    assert_eq!(body["text"]["paragraphs"][0]["runs"][0]["size"], 32.0);
    assert_eq!(slides[1]["background"], "#ffffff");
    assert_eq!(title["text"]["paragraphs"][0]["runs"][0]["color"], "#000000");
}

#[test]
fn a_deck_resolves_groups_pictures_lines_tables_and_theme_colours() {
    let theme = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1></a:clrScheme></a:themeElements></a:theme>"#;
    let master = r#"<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/><p:txStyles><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>"#;
    let layout = r#"<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>"#;
    let slide = r#"<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:bgPr></p:bg><p:spTree>
<p:grpSp><p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr>
<p:txBody><a:bodyPr anchor="b"/><a:lstStyle/><a:p><a:pPr algn="ctr"><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:rPr sz="2000" b="1"/><a:t>in group</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp>
<p:pic><p:nvPicPr><p:cNvPr id="3" name="pic" descr="logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm></p:spPr></p:pic>
<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="l"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm flipV="1"><a:off x="0" y="635000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="12700"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></p:spPr></p:cxnSp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="3810000"/><a:ext cx="2540000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="1270000"/><a:gridCol w="1270000"/></a:tblGrid>
<a:tr h="635000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr h="635000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>span</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>"#;
    let rels = |t: &str, target: &str| format!(r#"<Relationships xmlns="x"><Relationship Id="rId1" Type="http://x/{t}" Target="{target}"/></Relationships>"#);
    let data = package(&[
        ("[Content_Types].xml", "<Types/>"),
        ("ppt/presentation.xml", r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>"#),
        ("ppt/_rels/presentation.xml.rels", &rels("slide", "slides/slide1.xml")),
        ("ppt/slides/slide1.xml", slide),
        ("ppt/slides/_rels/slide1.xml.rels", r#"<Relationships xmlns="x"><Relationship Id="rId1" Type="http://x/slideLayout" Target="../slideLayouts/l.xml"/><Relationship Id="rId5" Type="http://x/image" Target="../media/logo.png"/></Relationships>"#),
        ("ppt/slideLayouts/l.xml", layout),
        ("ppt/slideLayouts/_rels/l.xml.rels", &rels("slideMaster", "../slideMasters/m.xml")),
        ("ppt/slideMasters/m.xml", master),
        ("ppt/slideMasters/_rels/m.xml.rels", &rels("theme", "../theme/theme1.xml")),
        ("ppt/theme/theme1.xml", theme),
        ("ppt/media/logo.png", "PNG"),
    ]);
    let deck: Value = serde_json::from_str(&model(Kind::Presentation, data).unwrap().0).unwrap();
    assert_eq!((deck["width"].as_f64(), deck["height"].as_f64()), (Some(960.0), Some(540.0)));
    let slide = &deck["slides"][0];
    assert_eq!(slide["background"], "#254061", "accent1 at half its lightness");
    let shapes = slide["shapes"].as_array().unwrap();
    // Group child: the group's offset (100 pt) plus its own 50 pt, the group scaled twofold.
    let ellipse = &shapes[0];
    assert_eq!((ellipse["x"].as_f64(), ellipse["y"].as_f64(), ellipse["w"].as_f64()), (Some(200.0), Some(100.0), Some(100.0)));
    assert_eq!(ellipse["geom"], "ellipse");
    assert_eq!(ellipse["fill"], "#1f497d");
    assert_eq!(ellipse["line"]["color"], "#ff0000");
    assert_eq!(ellipse["text"]["anchor"], "b");
    assert_eq!(ellipse["text"]["paragraphs"][0]["bullet"], "1.");
    assert_eq!(ellipse["text"]["paragraphs"][0]["runs"][0]["bold"], true);
    assert_eq!(shapes[1]["type"], "picture");
    assert_eq!(shapes[1]["src"], "office-image:ppt/media/logo.png");
    assert_eq!((shapes[2]["geom"].as_str(), shapes[2]["flipV"].as_bool()), (Some("line"), Some(true)));
    // The table's cells: two header cells, one spanning cell (its merged half is not drawn).
    let cells: Vec<&Value> = shapes.iter().skip(3).collect();
    assert_eq!(cells.len(), 3);
    assert_eq!(cells[0]["fill"], "#4f81bd");
    assert_eq!(cells[2]["w"], 200.0);
}

#[test]
fn a_zip_bomb_and_a_foreign_file_are_refused() {
    assert_eq!(model(Kind::Spreadsheet, fixture("bomb.xlsx")).unwrap_err(), "office-limit");
    assert_eq!(model(Kind::Word, fixture("broken.docx")).unwrap_err(), "office-invalid");
    assert_eq!(model(Kind::Spreadsheet, fixture("broken.docx")).unwrap_err(), "office-invalid");
    // A package of another kind is invalid, not unreadable.
    assert_eq!(model(Kind::Presentation, fixture("sample.docx")).unwrap_err(), "office-invalid");
    assert_eq!(model(Kind::Word, vec![0; super::OFFICE_MAX_BYTES + 1]).unwrap_err(), "office-limit");
    let many: Vec<(String, &str)> = (0..4001).map(|i| (format!("f{i}.txt"), "x")).collect();
    let refs: Vec<(&str, &str)> = many.iter().map(|(n, b)| (n.as_str(), *b)).collect();
    assert_eq!(model(Kind::Word, package(&refs)).unwrap_err(), "office-limit");
}

#[test]
fn a_full_size_picture_is_scaled_down_and_a_small_one_kept() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as B64;
    let png = |w: u32, h: u32, alpha: bool| {
        let mut out = std::io::Cursor::new(Vec::new());
        let picture = if alpha {
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(w, h, image::Rgba([10, 20, 30, 128])))
        } else {
            image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, image::Rgb([10, 20, 30])))
        };
        picture.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    };
    let decode = |url: &str| {
        let (head, data) = url.split_once(',').unwrap();
        (head.to_string(), image::load_from_memory(&B64.decode(data).unwrap()).unwrap())
    };
    let (head, big) = decode(&super::picture::data_url("ppt/media/photo.png", png(3000, 600, false), 1000));
    assert_eq!(head, "data:image/jpeg;base64");
    assert_eq!((big.width(), big.height()), (1000, 200));
    let (head, clear) = decode(&super::picture::data_url("word/media/logo.png", png(2400, 2400, true), 1000));
    assert_eq!(head, "data:image/png;base64");
    assert_eq!((clear.width(), clear.height()), (1000, 1000));
    let small = png(40, 30, false);
    assert_eq!(super::picture::data_url("word/media/dot.png", small.clone(), 1000), format!("data:image/png;base64,{}", B64.encode(small)));
    assert_eq!(super::picture::data_url("word/media/a.emf", vec![1, 2, 3], 1000), format!("data:{};base64,AQID", super::archive::mime_of("word/media/a.emf")));
}
