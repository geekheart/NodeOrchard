"""Rebuild a native-control manufacturing form from an EPRO2 and a reviewable profile.

The Artifact Tool authors cell values. A deterministic preservation pass transfers
those values into the original OOXML package because its XLSX exporter drops Excel
form controls. Original styles, control bindings and drawing anchors are retained;
both ctrlProps and VML states are updated. No EDA source is modified.
"""
from __future__ import annotations

import argparse
import collections
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr
import zipfile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"s": MAIN, "r": REL}
RUNTIME = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies"
DEFAULT_TEMPLATE = Path(os.environ.get('WORKBENCH_HDK_PROCESS_TEMPLATE',
    Path(os.environ.get('WORKBENCH_HDK_SOURCE_ROOT', Path.home() / 'Documents/文档整理')).expanduser()
    / 'WT9932S31-TINY_HDK_V1.0/生产资料/06_工艺要求/WT9932S31-TINY-1V0-20261021.xlsx')).expanduser()
GUIDELINES = "https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/pcb-layout-design-esp32p4.html"
REFERENCE_PROFILE = {
    "schemaVersion": 1,
    "material": "FR-4",
    "nominalThicknessMm": 1.6,
    "innerCopperOz": 0.5,
    "outerCopperOz": 1,
    "tg": "Normal TG(130度以上",
    "solderMaskColor": "哑光黑色",
    "silkscreenColor": "白色",
    "surfaceFinish": "无铅喷锡",
    "electricalTest": True,
    "viaMask": "from_file",
    "ulMark": False,
    "manufactureDateMark": True,
    "dateCode": "年周",
    "otherMark": "无",
    "orderQuantity": None,
    "deliveryDate": None,
    "printLayout": "landscape_a3",
    "impedanceTargets": [
        {"name": "USB", "netPattern": "USB|^D[+-]$", "kind": "differential", "targetOhms": 90, "tolerancePercent": 10},
        {"name": "MIPI", "netPattern": "CSI_[A-Z]*[NP][01]?$|DSI_[A-Z]*[NP][01]?$", "kind": "differential", "targetOhms": 100, "tolerancePercent": 10},
        {"name": "SDIO", "netPattern": "(^|_)SD_(D[0-3]|CLK|CMD)$|SDIO", "kind": "single-ended", "targetOhms": 50, "tolerancePercent": 10},
    ],
}
PROFILE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
    "additionalProperties": False, "required": ["schemaVersion"],
    "properties": {
        "schemaVersion": {"const": 1}, "material": {"enum": ["FR-4"]},
        "nominalThicknessMm": {"type": "number", "minimum": 0.4, "maximum": 3.2},
        "innerCopperOz": {"type": "number", "enum": [0.5, 1, 2]},
        "outerCopperOz": {"type": "number", "enum": [0.5, 1, 2]},
        "tg": {"type": "string", "maxLength": 60},
        "solderMaskColor": {"type": "string", "maxLength": 30},
        "silkscreenColor": {"type": "string", "maxLength": 30},
        "surfaceFinish": {"enum": ["无铅喷锡", "化学沉金", "电镀金", "防氧化"]},
        "electricalTest": {"type": "boolean"},
        "viaMask": {"enum": ["from_file", "covered", "open"]},
        "ulMark": {"type": "boolean"}, "manufactureDateMark": {"type": "boolean"},
        "dateCode": {"enum": ["年周", "周年"]}, "otherMark": {"enum": ["无", "档案号", "防静电标"]},
        "orderQuantity": {"type": ["integer", "null"], "minimum": 1, "maximum": 10000000},
        "deliveryDate": {"type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}$"},
        "printLayout": {"enum": ["landscape_a3", "template"]},
        "impedanceTargets": {"type": "array", "maxItems": 6, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["name", "netPattern", "kind", "targetOhms", "tolerancePercent"],
            "properties": {"name": {"type": "string", "maxLength": 24},
                           "netPattern": {"type": "string", "maxLength": 100},
                           "kind": {"enum": ["differential", "single-ended"]},
                           "targetOhms": {"type": "number", "minimum": 20, "maximum": 200},
                           "tolerancePercent": {"type": "number", "minimum": 1, "maximum": 20}},
        }},
    },
}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def _records(path: Path):
    if path.suffix.lower() != ".epro2":
        raise ValueError("sourcePath must be an .epro2 archive")
    with zipfile.ZipFile(path) as z:
        if sum(x.file_size for x in z.infolist()) > 100 * 1024 * 1024:
            raise ValueError("EPRO2 uncompressed size exceeds 100 MiB")
        names = [n for n in z.namelist() if n.endswith(".epru")]
        if len(names) != 1:
            raise ValueError("Expected one .epru source member")
        project = json.loads(z.read("project2.json"))
        docs, current = [], None
        for line in z.read(names[0]).decode("utf-8").splitlines():
            if "||" not in line:
                continue
            a, b = line.split("||", 1)
            try:
                a = json.loads(a)
                payload = b.removesuffix("|")
                b = json.loads(payload) if payload.strip() else None
            except (ValueError, TypeError) as e:
                raise ValueError("Malformed native EPRU record") from e
            if a.get("type") == "DOCHEAD":
                if b is None: raise ValueError("Empty DOCHEAD")
                current = {"head": b, "records": []}
                docs.append(current)
            if current is not None:
                current["records"].append((a, b))
    # Empty payloads are CRDT tombstones. Fold by record identity/ticket rather
    # than treating deletions as malformed JSON or resurrecting earlier geometry.
    for doc in docs:
        latest = {}
        for i, (a, b) in enumerate(doc['records']):
            key = (a.get('type'), a.get('id', f'position:{i}'))
            if key not in latest or a.get('ticket', 0) >= latest[key][0].get('ticket', 0): latest[key] = (a, b)
        doc['records'] = [(a,b) for a,b in latest.values() if b is not None]
    return project, docs


def _arc_points(start, end, degrees):
    """Sample the native endpoint/sweep representation, including exact extrema."""
    x1, y1 = start; x2, y2 = end
    theta = math.radians(float(degrees))
    chord = math.hypot(x2-x1, y2-y1)
    if chord == 0 or abs(math.sin(theta/2)) < 1e-8:
        return [start, end]
    h = chord / (2 * math.tan(theta/2))
    cx = (x1+x2)/2 - (y2-y1)*h/chord
    cy = (y1+y2)/2 + (x2-x1)*h/chord
    radius = math.hypot(x1-cx, y1-cy)
    begin = math.atan2(y1-cy, x1-cx)
    angles = [begin + theta*i/max(2, int(abs(degrees)/5)) for i in range(max(2, int(abs(degrees)/5))+1)]
    for q in range(4):
        candidate = q*math.pi/2
        delta = ((candidate-begin) % (2*math.pi)) if theta > 0 else -((begin-candidate) % (2*math.pi))
        if min(0, theta)-1e-8 <= delta <= max(0, theta)+1e-8:
            angles.append(begin+delta)
    return [(cx+radius*math.cos(v), cy+radius*math.sin(v)) for v in angles]


def _poly_points(path):
    if not path:
        return []
    if path[0] == "R":
        if len(path) < 6:
            raise ValueError("Malformed native rectangle")
        x, y, w, h, rotation = map(float, path[1:6])
        if abs(rotation) > 1e-6:
            raise ValueError("Rotated board rectangle needs a native-export boundary check")
        return [(x, y), (x+w, y), (x+w, y-h), (x, y-h), (x, y)]
    if not isinstance(path[0], (int, float)) or len(path) < 2:
        raise ValueError("Unsupported board path representation")
    current = (float(path[0]), float(path[1])); points = [current]; i = 2
    while i < len(path):
        command = path[i]; i += 1
        if command == "L":
            current = (float(path[i]), float(path[i+1])); points.append(current); i += 2
        elif command == "ARC":
            end = (float(path[i+1]), float(path[i+2]))
            points.extend(_arc_points(current, end, float(path[i]))); current = end; i += 3
        elif command in ("Z", "CLOSE"):
            points.append(points[0])
        else:
            raise ValueError(f"Unsupported board path command: {command!r}")
    return points


def _source_data(path: Path, pcb_uuid=None):
    project, docs = _records(path)
    boards = [d for d in docs if d["head"].get("docType") == "PCB" and (not pcb_uuid or d["head"].get("uuid") == pcb_uuid)]
    if len(boards) != 1:
        raise ValueError("Select one PCB with pcbUuid for a multi-board source")
    records = boards[0]["records"]
    layers = {b.get("layerId"): b for a, b in records if a.get("type") == "LAYER"}
    copper = [b for b in layers.values() if b.get("use") and b.get("layerType") in ("TOP", "BOTTOM", "SIGNAL", "PLANE")]
    physical = []
    for a, b in records:
        if a.get("type") == "LAYER_PHYS":
            layer_id = json.loads(a["id"])[1]
            physical.append({"layerId": layer_id, **b})
    physical.sort(key=lambda b: b.get("zIndex", 0))
    order = {b["layerId"]: i for i, b in enumerate(physical)}
    copper.sort(key=lambda b: order.get(b["layerId"], 10000))
    outlines = []
    for a, b in records:
        if b.get("layerId") == 11:
            if a.get("type") == "POLY":
                outlines.append(_poly_points(b["path"]))
            elif a.get("type") == "LINE":
                outlines.append([(b["startX"], b["startY"]), (b["endX"], b["endY"])])
            elif a.get("type") == "ARC":
                outlines.append(_arc_points((b["startX"], b["startY"]), (b["endX"], b["endY"]), b.get("angle", b.get("sweepAngle"))))
    points = [p for o in outlines for p in o]
    if not points:
        raise ValueError("Source has no supported board-outline geometry on layer 11")
    bounds = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
    versions = sorted({str(b["value"]) for d in docs if d["head"].get("docType") == "SCH_PAGE" for a, b in d["records"] if a.get("type") == "ATTR" and b.get("key") == "Version" and b.get("value")})
    components = sum(a.get("type") == "COMPONENT" for a, b in records)
    via_types = collections.Counter(b.get("viaType") for a, b in records if a.get("type") == "VIA")
    copper_phys = [b for b in physical if b["layerId"] in {c["layerId"] for c in copper}]
    signal_nets = sorted({b.get('netName','') for a,b in records if a.get('type') in ('LINE','ARC') and b.get('netName')})
    differential_pairs = collections.defaultdict(list)
    for a,b in records:
        if a.get('type')=='NET' and b.get('differentialName'):
            net_id = json.loads(a['id'])
            differential_pairs[b['differentialName']].append(net_id[1])
    facts = {
        "sourcePath": str(path.resolve()), "sourceSha256": _sha(path.read_bytes()),
        "projectTitle": project.get("title"), "editorVersion": project.get("editorVersion"),
        "pcbUuid": boards[0]["head"].get("uuid"), "versions": versions,
        "componentCount": components, "viaTypes": dict(via_types),
        "coordinateUnit": "mil (native EPRU geometry)",
        "boundsMil": bounds, "widthMm": (bounds[2]-bounds[0])*.0254, "heightMm": (bounds[3]-bounds[1])*.0254,
        "layerCount": len(copper), "copperLayers": [{"layerId": b["layerId"], "name": b["layerName"], "type": b["layerType"]} for b in copper],
        "physicalStack": physical, "stackThicknessMm": sum(b.get("thickness") or 0 for b in physical)*.0254,
        "copperThicknessUm": [{"layerId": b["layerId"], "thicknessUm": float(b.get("thickness") or 0)*25.4, "material": b.get("material")} for b in copper_phys],
        "materialExplicitFr4": any("FR4" in re.sub(r"[\s-]", "", b.get("material") or "").upper() for b in physical),
        "signalNets": signal_nets,
        "nativeDifferentialPairs": dict(differential_pairs),
        "warnings": [],
    }
    if len(copper) not in (1, 2, 4, 6, 8):
        raise ValueError("Unsupported copper layer count for this manufacturing template")
    if facts["stackThicknessMm"] <= 0:
        facts["warnings"].append("Source lacks physical stack thickness; nominal thickness is a manufacturing-profile choice.")
    rule_template = next((b.get("name") for a, b in records if a.get("type") == "RULE_TEMPLATE"), "")
    if len(copper) != 2 and "Two Layers" in rule_template:
        facts["warnings"].append("Stale Two Layers capability-template name; actual enabled copper layers take precedence.")
    return facts, records, outlines


def _profile(value):
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(PROFILE_SCHEMA["properties"]):
        raise ValueError("Unknown process-profile fields; geometry/layer overrides are not allowed")
    out = copy.deepcopy(REFERENCE_PROFILE); out.update(copy.deepcopy(value))
    for key, schema in PROFILE_SCHEMA["properties"].items():
        v = out[key]
        if "enum" in schema and v not in schema["enum"]:
            raise ValueError(f"Invalid profile {key}: {v!r}")
        if schema.get("type") == "boolean" and type(v) is not bool:
            raise ValueError(f"Profile {key} must be boolean")
        if schema.get("type") == "number" and (type(v) not in (int, float) or not math.isfinite(v) or not schema.get("minimum", 0) <= v <= schema.get("maximum", 100)):
            raise ValueError(f"Invalid numeric profile {key}")
        if schema.get("type") == "string" and (not isinstance(v, str) or len(v) > schema.get("maxLength", 100)):
            raise ValueError(f"Invalid text profile {key}")
    if out["schemaVersion"] != 1 or (out["orderQuantity"] is not None and (type(out["orderQuantity"]) is not int or not 1 <= out["orderQuantity"] <= 10000000)):
        raise ValueError("Invalid profile version or quantity")
    if out["deliveryDate"] is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(out["deliveryDate"])):
        raise ValueError("Invalid deliveryDate")
    if out['deliveryDate'] is not None:
        from datetime import date
        date.fromisoformat(out['deliveryDate'])
    if not isinstance(out["impedanceTargets"], list) or len(out["impedanceTargets"]) > 6:
        raise ValueError("Invalid impedanceTargets")
    keys = set(PROFILE_SCHEMA["properties"]["impedanceTargets"]["items"]["properties"])
    for t in out["impedanceTargets"]:
        if not isinstance(t, dict) or set(t) != keys or t["kind"] not in ("differential", "single-ended"):
            raise ValueError("Invalid impedance target schema")
        if not isinstance(t["name"], str) or len(t["name"]) > 24 or not isinstance(t["netPattern"], str) or len(t["netPattern"]) > 100:
            raise ValueError("Invalid impedance label/pattern")
        if re.search(r"[()]|\\[1-9]", t["netPattern"]):
            # Simple patterns only. Parentheses are allowed solely for ordinary
            # non-capturing boundary alternatives used by the reference profile.
            if t["netPattern"] != REFERENCE_PROFILE["impedanceTargets"][2]["netPattern"]:
                raise ValueError("Use a simple impedance netPattern without nested groups")
        re.compile(t["netPattern"], re.I)
        if type(t["targetOhms"]) not in (int, float) or not 20 <= t["targetOhms"] <= 200 or type(t["tolerancePercent"]) not in (int, float) or not 1 <= t["tolerancePercent"] <= 20:
            raise ValueError("Invalid impedance target numbers")
    return out


def _parameters(params):
    if not isinstance(params, dict):
        raise ValueError("Expected a parameter object")
    source = Path(params["sourcePath"]).expanduser().resolve()
    product = params.get("productCode")
    version = params.get("hardwareVersion", "V1.0")
    date = params.get("releaseDate")
    if not isinstance(product, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", product):
        raise ValueError("Invalid productCode")
    match = re.fullmatch(r"V?(\d{1,3})[.Vv](\d{1,3})", version)
    if not match:
        raise ValueError("hardwareVersion must be V1.0, 1.0 or 1V0")
    normalized_version = f"V{int(match[1])}.{int(match[2])}"
    if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("releaseDate must be YYYY-MM-DD")
    from datetime import date as date_type
    date_type.fromisoformat(date)
    facts, records, outlines = _source_data(source, params.get("pcbUuid"))
    if facts["versions"] and normalized_version not in facts["versions"]:
        raise ValueError(f"Requested {normalized_version} differs from source versions {facts['versions']}")
    template = Path(params.get("templatePath", DEFAULT_TEMPLATE)).expanduser().resolve()
    profile = _profile(params.get("profile"))
    return source, product, normalized_version, date, template, profile, facts, records, outlines


def prepare_process_request(params: dict) -> dict:
    """Read only: facts and the small Skill's profile contract. No output files."""
    source, product, version, date, template, profile, facts, records, outlines = _parameters(params)
    return {"schemaVersion": 1, "capability": "hdk-process-requirements", "productCode": product,
            "hardwareVersion": version, "releaseDate": date, "facts": facts,
            "templatePath": str(template), "profileSchema": copy.deepcopy(PROFILE_SCHEMA),
            "referenceProfile": profile,
            "detectedSignalFamilies": _effective_targets(records, _profile(None)),
            "instructions": "Return only a profile matching profileSchema. Source geometry, layer count, identity and version cannot be overridden. Template colors/finish/Tg/nominal thickness are manufacturing choices, not measured facts."}


def _xlsx_read(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        strings = ["".join(s.itertext()) for s in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("s:si", NS)]
    rels = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    book = ET.fromstring(z.read("xl/workbook.xml")); sheets = []
    for s in book.findall("s:sheets/s:sheet", NS):
        target = rels[s.attrib[f"{{{REL}}}id"]]
        name = target.lstrip("/") if target.startswith("/") else "xl/"+target
        tree = ET.fromstring(z.read(name)); values = {}
        for c in tree.findall("s:sheetData/s:row/s:c", NS):
            v = c.find("s:v", NS)
            value = v.text if v is not None else None
            if c.attrib.get("t") == "s":
                value = strings[int(value)] if value is not None else ""
            elif c.attrib.get("t") == "inlineStr":
                inline = c.find("s:is", NS); value = "".join(inline.itertext()) if inline is not None else ""
            elif value is not None and c.attrib.get("t") not in ("str", "b", "e"):
                try: value = float(value)
                except ValueError: pass
            values[c.attrib["r"]] = value
        sheets.append({"name": s.attrib["name"], "member": name, "tree": tree, "values": values})
    return z, sheets


def _template_controls(z, sheets):
    main = sheets[0]
    rel_member = str(Path(main["member"]).parent / "_rels" / (Path(main["member"]).name+".rels"))
    relationships = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(z.read(rel_member))}
    bindings = {}
    import posixpath
    for c in main["tree"].iter():
        if c.tag.endswith("}control"):
            target = relationships[c.attrib[f"{{{REL}}}id"]]
            member = posixpath.normpath(posixpath.join(str(Path(main["member"]).parent), target))
            bindings[c.attrib["shapeId"]] = {"member": member, "binding": dict(c.attrib)}
    vml_member = next((n for n in z.namelist() if n.endswith(".vml")), None)
    if not vml_member:
        raise ValueError("Template has no VML form controls")
    vml = ET.fromstring(z.read(vml_member)); controls = {}
    options = sheets[1]["values"]
    for shape in vml:
        if not shape.tag.endswith("shape"):
            continue
        shape_id = re.sub(r"^_x0000_s", "", shape.attrib.get("id", ""))
        client = next((e for e in shape if e.tag.endswith("ClientData")), None)
        if client is None or shape_id not in bindings:
            continue
        vals = {e.tag.split("}")[-1]: e.text for e in client}
        text = next((e for e in shape if e.tag.endswith("textbox")), None)
        prop = ET.fromstring(z.read(bindings[shape_id]["member"]))
        choices = []
        match = re.fullmatch(r"[^!]+!\$([A-Z]+)\$([0-9]+):\$([A-Z]+)\$([0-9]+)", vals.get("FmlaRange") or "")
        if match and match[1] == match[3]:
            choices = [options.get(f"{match[1]}{i}") for i in range(int(match[2]), int(match[4])+1)]
        controls[shape_id] = {**bindings[shape_id], "shape": shape, "client": client, "prop": prop,
                              "state": vals, "choices": choices, "label": "".join(text.itertext()) if text is not None else ""}
    return controls, vml_member


def _normalized(v):
    return re.sub(r"\s|[\-－]", "", str(v or "")).lower()


def _control_choice(controls, shape_id, value):
    c = controls[str(shape_id)]
    for i, v in enumerate(c["choices"], 1):
        if _normalized(v) == _normalized(value):
            return i
    raise ValueError(f"Template has no {value!r} option for control {shape_id}")


def _effective_targets(records, profile):
    netnames = {b.get("netName", "") for a, b in records if a.get("type") in ("LINE", "ARC")}
    result = []
    for t in profile["impedanceTargets"]:
        names = sorted(n for n in netnames if n and re.search(t["netPattern"], n, re.I))
        if names:
            result.append({**t, "nets": names, "source": "protocol manufacturing target; not impedance measurement", "reference": GUIDELINES})
    return result


def _diagram_bytes(facts, records, outlines, targets, product):
    from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
    target_map = {n: i for i, t in enumerate(targets) for n in t["nets"]}
    selected = [(a, b) for a, b in records if a.get("type") in ("LINE", "ARC") and b.get("netName") in target_map]
    layer_ids = [c["layerId"] for c in facts["copperLayers"] if any(b.get("layerId") == c["layerId"] for a, b in selected)]
    if not layer_ids:
        layer_ids = [facts["copperLayers"][0]["layerId"]]
    cols = 2 if len(layer_ids) > 2 else 1; rows = math.ceil(len(layer_ids)/cols)
    # Match the reviewed template picture's 877:712 aspect ratio, so keeping its
    # native drawing anchor cannot distort the current board geometry.
    width, height = 1600, round(1600*712/877)
    panel_w, panel_h = width/cols, (height-255)/rows
    img = Image.new("RGB", (width, height), "white"); draw = ImageDraw.Draw(img)
    font_path = next((str(p) for p in [Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")] if p.exists()), None)
    font = ImageFont.truetype(font_path, 22) if font_path else ImageFont.load_default()
    small = ImageFont.truetype(font_path, 18) if font_path else ImageFont.load_default()
    draw.text((35, 16), f"{product}  PCB trace / impedance targets", fill="#202020", font=font)
    draw.text((35, 49), f"Source SHA256: {facts['sourceSha256'][:24]}   Geometry: {facts['widthMm']:.3f} x {facts['heightMm']:.3f} mm", fill="#4a4a4a", font=small)
    palette = ["#c62828", "#1565c0", "#2e7d32", "#7b1fa2", "#ef6c00", "#00838f"]
    for i, t in enumerate(targets):
        label = f"{t['name']} {t['kind']} {t['targetOhms']:g} ohm +/-{t['tolerancePercent']:g}%"
        draw.text((35+(i%3)*520, 85+(i//3)*28), label, fill=palette[i], font=small)
    bounds = facts["boundsMil"]; bw = bounds[2]-bounds[0]; bh = bounds[3]-bounds[1]
    for k, layer_id in enumerate(layer_ids):
        ox, oy = (k%cols)*panel_w, 155+(k//cols)*panel_h
        scale = min((panel_w-85)/bw, (panel_h-90)/bh)
        def point(xy):
            return (ox+42+(xy[0]-bounds[0])*scale, oy+60+(bounds[3]-xy[1])*scale)
        name = next(c["name"] for c in facts["copperLayers"] if c["layerId"] == layer_id)
        draw.text((ox+35, oy+15), f"{name} (native layer {layer_id})", fill="#202020", font=font)
        for outline in outlines:
            if len(outline) > 1: draw.line([point(p) for p in outline], fill="#7a7a7a", width=3)
        for a, b in records:
            if a.get("type") == "LINE" and b.get("layerId") == layer_id:
                draw.line([point((b["startX"], b["startY"])), point((b["endX"], b["endY"]))], fill="#e2e2e2", width=1)
        for a, b in selected:
            if b.get("layerId") != layer_id: continue
            if a["type"] == "LINE":
                path = [(b["startX"], b["startY"]), (b["endX"], b["endY"])]
            elif all(v in b for v in ("startX", "startY", "endX", "endY")) and ("angle" in b or "sweepAngle" in b):
                path = _arc_points((b["startX"], b["startY"]), (b["endX"], b["endY"]), b.get("angle", b.get("sweepAngle")))
            else: continue
            draw.line([point(p) for p in path], fill=palette[target_map[b["netName"]]], width=max(2, min(7, round(float(b.get("width", 6))*scale))))
    draw.text((35, height-75), "Manufacturing targets only. Stack-up / coupon to be confirmed by fabricator; not a measured impedance report.", fill="#303030", font=small)
    draw.text((35, height-42), "Only current-source traces are highlighted; colors identify protocol groups; each panel identifies its actual routing layer.", fill="#303030", font=small)
    info = PngImagePlugin.PngInfo()
    info.add_text("sourceSha256", facts["sourceSha256"])
    info.add_text("highlightedNets", json.dumps(sorted(target_map), ensure_ascii=False))
    info.add_text("layerIds", json.dumps(layer_ids))
    buf = io.BytesIO(); img.save(buf, format="PNG", pnginfo=info)
    return buf.getvalue(), {"highlightedNets": sorted(target_map), "layerIds": layer_ids, "sha256": _sha(buf.getvalue()), "sizePixels": [width, height]}


def _edit_plan(facts, profile, product, version, date, controls, targets):
    compact_version = version[1:].replace(".", "V")
    thickness = profile["nominalThicknessMm"]
    if facts["stackThicknessMm"] and abs(thickness-facts["stackThicknessMm"]) > .15:
        raise ValueError("Nominal board thickness conflicts with source physical stack by more than 0.15 mm")
    if any(kind not in ('NORMAL','SUTURE',None) for kind in facts['viaTypes']):
        raise ValueError('This template capability needs an explicit process extension for blind/buried/special via types')
    for copper in facts['copperThicknessUm']:
        if copper['thicknessUm'] <= 0: continue
        nearest = min((.5, 1, 2), key=lambda oz: abs(oz*35-copper['thicknessUm']))
        configured = profile['outerCopperOz'] if copper['layerId'] in (1,2) else profile['innerCopperOz']
        if configured != nearest:
            raise ValueError(f"Profile copper weight conflicts with source layer {copper['layerId']} ({copper['thicknessUm']:.3f}um)")
    cells = {"C5": f"{product}-{compact_version}", "H5": compact_version,
             "M5": product, "E11": profile["orderQuantity"] or "按采购订单",
             "N11": profile["deliveryDate"] or "按采购订单",
             "E13": round(facts["widthMm"], 3), "I13": round(facts["heightMm"], 3), "E14": thickness,
             "P18": None, "E20": "按板框加工", "S32": "高亮为当前板真实走线；协议及目标见图例。",
             "A34": "阻抗目标："+"；".join(f"{t['name']}{'差分' if t['kind']=='differential' else '单端'}{t['targetOhms']:g}Ω±{t['tolerancePercent']:g}%" for t in targets),
             "A35": f"板厚名义值{thickness:g}mm；源层叠合计{facts['stackThicknessMm']:.3f}mm。制造前按当前工程核叠层及阻抗。"}
    # Native Calc preserves the form-control objects but omits their text/list
    # values in PDF export. Publish an explicit snapshot in existing blank rows;
    # this does not replace or flatten the 45 editable native controls.
    inner = f"内铜{profile['innerCopperOz']:g}oz" if facts['layerCount'] > 2 else "无内铜"
    cells['B30'] = f"发布参数：{facts['layerCount']}层，{profile['material']}，外铜{profile['outerCopperOz']:g}oz，{inner}"
    tg = re.search(r'\d+', profile['tg'])
    tg_label = f"Tg≥{tg.group()}℃" if tg else profile['tg']
    cells['B31'] = f"工艺默认：{profile['solderMaskColor']} / {profile['silkscreenColor']} / {profile['surfaceFinish']} / {tg_label} / 电测{'是'if profile['electricalTest']else'否'}"
    cells['B32'] = '层序：'+'/'.join(c['name'].replace(' Layer','').replace('Inner','IN')for c in facts['copperLayers'])+'；过孔按文件，非塞孔。'
    selectors = {}
    def choice(shape, value): selectors[str(shape)] = {"sel": _control_choice(controls, shape, value)}
    def check(shape, value): selectors[str(shape)] = {"checked": bool(value)}
    choice(1029, "单面" if facts["layerCount"] == 1 else "双面" if facts["layerCount"] == 2 else f"{facts['layerCount']}层")
    choice(1049, profile["material"]); choice(1069, profile["tg"])
    choice(1032, f"{profile['outerCopperOz']:g} oz")
    if facts["layerCount"] > 2:
        choice(1031, f"{profile['innerCopperOz']:g} oz")
    else:
        selectors["1031"] = {"sel": 1}; cells["E16"] = "内层：不适用"
    choice(1033, "双面"); choice(1035, "双面")
    choice(1034, profile["solderMaskColor"]); choice(1036, profile["silkscreenColor"])
    choice(1047, "Gerber 文件"); choice(1052, "按文件中说明要求")
    choice(1051, None); choice(1059, profile["dateCode"]); choice(1060, None if profile["otherMark"] == "无" else profile["otherMark"])
    for shape in (1025, 1026, 1027): check(shape, shape == 1025)
    for shape, finish in ((1042,"无铅喷锡"),(1043,"电镀金"),(1044,"化学沉金"),(1045,"防氧化"),(1046,"其他")):
        check(shape, finish == profile["surfaceFinish"])
    check(1037, profile["electricalTest"]); check(1038, not profile["electricalTest"])
    for shape, mode in ((1039,"covered"),(1040,"open"),(1041,"from_file")): check(shape, mode == profile["viaMask"])
    check(1053, False)
    check(1054, profile["ulMark"]); check(1048, not profile["ulMark"])
    check(1055, profile["manufactureDateMark"]); check(1057, not profile["manufactureDateMark"])
    check(1056, False); check(1058, True)  # No unspecified additional certification / other mark.
    for shape in (1062,1063,1064,1065,1066,1067,1068): check(shape, shape == 1062)
    check(1072, bool(targets)); check(1073, not targets)
    check(1070, False)
    return cells, selectors


def _author_cells(template, values, qa, params):
    node = Path(params.get("nodePath", RUNTIME/"node/bin/node"))
    modules = Path(params.get("nodeModulesPath", RUNTIME/"node/node_modules"))
    if not node.is_file() or not (modules/"@oai/artifact-tool").exists():
        raise RuntimeError("Bundled Artifact Tool runtime is unavailable; supply nodePath/nodeModulesPath")
    with tempfile.TemporaryDirectory(prefix="author-", dir=qa) as tmp:
        tmp = Path(tmp); (tmp/"node_modules").symlink_to(modules, target_is_directory=True)
        payload = tmp/"values.json"; _json_write(payload, {"template": str(template), "cells": values})
        script = tmp/"author.mjs"
        script.write_text("""import fs from 'node:fs/promises';
import {FileBlob,SpreadsheetFile} from '@oai/artifact-tool';
const p=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const w=await SpreadsheetFile.importXlsx(await FileBlob.load(p.template));
const s=w.worksheets.getItemAt(0);
for(const [cell,value] of Object.entries(p.cells)) s.getRange(cell).values=[[value]];
for(const cell of ['B30','B31']) s.getRange(cell).format.font={name:'宋体',size:12};
w.recalculate();
await (await SpreadsheetFile.exportXlsx(w)).save(process.argv[3]);
""", encoding="utf-8")
        authored = tmp/"authored.xlsx"
        result = subprocess.run([str(node), str(script), str(payload), str(authored)], capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError("Artifact Tool cell authoring failed: "+result.stderr[-1800:])
        z, sheets = _xlsx_read(authored.read_bytes())
        reread = {k: sheets[0]["values"].get(k) for k in values}
        for key, value in values.items():
            if reread[key] != value and not (value is None and reread[key] in (None, "")):
                raise RuntimeError(f"Artifact Tool reread mismatch in {key}")
        return reread


def _replace_cell(xml, address, value, style_index=None):
    pattern = re.compile(r'<c\b(?=[^>]*\br="'+re.escape(address)+r'")([^>]*?)(?:\s*/>|>.*?</c>)', re.S)
    match = pattern.search(xml)
    attrs = match.group(1) if match else f' r="{address}"'
    attrs = re.sub(r'\s+t="[^"]*"', '', attrs)
    if style_index is not None:
        attrs = re.sub(r'\s+s="[^"]*"', '', attrs)+f' s="{style_index}"'
    if value is None:
        cell = f'<c{attrs}/>'
    elif type(value) in (int, float):
        cell = f'<c{attrs}><v>{value:g}</v></c>'
    else:
        cell = f'<c{attrs} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'
    if match:
        return xml[:match.start()]+cell+xml[match.end():]
    row_number = re.search(r"\d+", address).group()
    row_pattern = re.compile(r'(<row\b(?=[^>]*\br="'+row_number+r'")[^>]*>)(.*?)(</row>)', re.S)
    row = row_pattern.search(xml)
    if not row:
        raise ValueError(f"Template has no editable row {row_number}")
    # Cells must stay in ascending column order for Excel and native controls.
    col = re.match(r"[A-Z]+", address).group()
    def index(s):
        n=0
        for char in s: n=n*26+ord(char)-64
        return n
    body=row.group(2); insertion=len(body)
    for c in re.finditer(r'<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\s*/>|>.*?</c>)', body, re.S):
        if index(c.group(1))>index(col): insertion=c.start(); break
    body=body[:insertion]+cell+body[insertion:]
    return xml[:row.start(2)]+body+xml[row.end(2):]


def _attr(xml, name, value):
    # These are tiny single-root ctrlProp elements. Preserve their existing prefix
    # declarations instead of reserializing complex worksheet XML namespaces.
    root = re.search(r'<(?:[\w]+:)?formControlPr\b[^>]*', xml)
    if not root: raise ValueError("Invalid ctrlProp root")
    part = root.group()
    self_closing = part.rstrip().endswith('/')
    if self_closing: part = part.rstrip()[:-1]
    part = re.sub(r'\s+'+re.escape(name)+r'="[^"]*"', '', part)
    if value is not None: part += " "+name+"="+quoteattr(str(value))
    if self_closing: part += '/'
    return xml[:root.start()]+part+xml[root.end():]


def _set_vml_state(xml, shape_id, state):
    pattern = re.compile(r'(<v:shape\b[^>]*\bid="_x0000_s'+shape_id+r'"[^>]*>)(.*?)(</v:shape>)', re.S)
    match = pattern.search(xml)
    if not match: raise ValueError(f"VML shape {shape_id} missing")
    body=match.group(2)
    for field, tag in (("checked", "Checked"), ("sel", "Sel")):
        if field not in state: continue
        body=re.sub(r'<x:'+tag+r'>.*?</x:'+tag+r'>', '', body, flags=re.S)
        value = (1 if state[field] else None) if field == "checked" else state[field]
        if value is not None: body=body.replace('</x:ClientData>', f'<x:{tag}>{value}</x:{tag}></x:ClientData>')
    return xml[:match.start(2)]+body+xml[match.end(2):]


def _fit_print(package, sheets, print_layout):
    if print_layout == "template": return
    workbook=package["xl/workbook.xml"].decode()
    workbook=re.sub(r'<definedName\b[^>]*name="_xlnm.Print_Area"[^>]*>.*?</definedName>', '', workbook, flags=re.S)
    defined=''.join(f'<definedName name="_xlnm.Print_Area" localSheetId="{i}">\'{escape(s["name"])}\'!$A$1:${"AE$39" if i==0 else "P$14"}</definedName>' for i,s in enumerate(sheets))
    if '</definedNames>'in workbook: workbook=workbook.replace('</definedNames>',defined+'</definedNames>')
    else: workbook=workbook.replace('</workbook>','<definedNames>'+defined+'</definedNames></workbook>')
    package["xl/workbook.xml"]=workbook.encode()
    for sheet in sheets:
        xml=package[sheet["member"]].decode()
        match=re.search(r'<pageSetup\b[^>]*/>',xml)
        setup='<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="1"/>'
        if match: xml=xml[:match.start()]+setup+xml[match.end():]
        else: xml=xml.replace('</worksheet>',setup+'</worksheet>')
        if '<pageSetUpPr' in xml:
            xml=re.sub(r'<pageSetUpPr\b[^>]*/>', '<pageSetUpPr fitToPage="1"/>',xml)
        elif '</sheetPr>'in xml: xml=xml.replace('</sheetPr>','<pageSetUpPr fitToPage="1"/></sheetPr>')
        else: xml=xml.replace('<dimension ','<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ',1)
        package[sheet["member"]]=xml.encode()


def _preserve_template(template_bytes, authored, selectors, diagram, profile):
    z, sheets=_xlsx_read(template_bytes); controls,vml_member=_template_controls(z,sheets)
    if len(sheets)!=2 or len(controls)!=45:
        raise ValueError("Expected the reviewed 2-sheet / 45-control manufacturing template")
    package={n:z.read(n)for n in z.namelist()if not n.endswith('/')}
    main=sheets[0]["member"];xml=package[main].decode()
    for address,value in authored.items(): xml=_replace_cell(xml,address,value,0 if address in ('B30','B31')else None)
    package[main]=xml.encode()
    vml=package[vml_member].decode()
    for shape_id,state in selectors.items():
        member=controls[shape_id]["member"];prop=package[member].decode()
        for name,value in state.items():prop=_attr(prop,name,('Checked'if value else None)if name=='checked'else value)
        package[member]=prop.encode();vml=_set_vml_state(vml,shape_id,state)
    package[vml_member]=vml.encode()
    image_names=[n for n in package if n.startswith('xl/media/')]
    if len(image_names)!=1 or not image_names[0].endswith('.png'):
        raise ValueError("Template must have one PNG impedance drawing")
    package[image_names[0]]=diagram
    _fit_print(package,sheets,profile['printLayout'])
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED)as out:
        for name,data in package.items():out.writestr(name,data)
    return buf.getvalue()


def _control_snapshot_workbook(workbook_bytes):
    """Make a clearly labelled print-only copy; never rewrite the native XLSX.

    Calc cannot print the legacy control captions. Its ordinary DrawingML text
    boxes do print, so the preview replaces only the 45 control fallback shapes
    with text at their original sheet anchors. Selection comes from ctrlProps,
    not from the profile or the original template's stale fallback text.
    """
    z, sheets = _xlsx_read(workbook_bytes)
    controls, _ = _template_controls(z, sheets)
    if len(controls) != 45: raise ValueError('Print snapshot requires the 45 reviewed native controls')
    package = {n:z.read(n) for n in z.namelist() if not n.endswith('/')}
    drawing_member = 'xl/drawings/drawing1.xml'
    drawing = package[drawing_member].decode()
    bindings = {c.attrib['shapeId']:c for c in sheets[0]['tree'].iter() if c.tag.endswith('}control')}
    entries = []

    def text_box(shape_id, text, start, end, font_size=900, heading=False):
        def marker(kind, values):
            return '<xdr:'+kind+'>'+''.join('<xdr:'+k+'>'+str(values[k])+'</xdr:'+k+'>'
                for k in ('col','colOff','row','rowOff'))+'</xdr:'+kind+'>'
        return ('<xdr:twoCellAnchor editAs="oneCell">'+marker('from',start)+marker('to',end)+
            '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="'+str(2000+int(shape_id))+'" name="原生控件发布快照 '+shape_id+'"/>'
            '<xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
            '<a:noFill/><a:ln><a:noFill/></a:ln></xdr:spPr><xdr:txBody>'
            '<a:bodyPr wrap="none" lIns="12700" rIns="0" tIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr>'
            '<a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="'+str(font_size)+'"'+(' b="1"'if heading else'')+'>'
            '<a:solidFill><a:srgbClr val="'+('315A72'if heading else'111111')+'"/></a:solidFill>'
            '<a:latin typeface="Songti SC"/><a:ea typeface="Songti SC"/></a:rPr><a:t>'+escape(text)+
            '</a:t></a:r><a:endParaRPr lang="zh-CN" sz="'+str(font_size)+'"/></a:p></xdr:txBody></xdr:sp>'
            '<xdr:clientData/></xdr:twoCellAnchor>')

    for shape_id, control in controls.items():
        prop = control['prop'].attrib
        label = re.sub(r'\s+', ' ', control['label']).strip()
        kind = prop.get('objectType', control['client'].attrib.get('ObjectType', ''))
        selected = int(prop.get('sel', 0))
        if control['choices']:
            value = control['choices'][selected-1] if 1 <= selected <= len(control['choices']) else None
            display = str(value).strip() if value is not None and str(value).strip() else '未选'
            if shape_id == '1059': display = '('+display+')'
        elif label:
            value = prop.get('checked') == 'Checked'
            display = ('[x] ' if value else '[ ] ') + label
        else:
            value = None
            display = '未填'
        anchor = next(e for e in bindings[shape_id].iter() if e.tag.endswith('}anchor'))
        points = []
        for edge in anchor:
            points.append({e.tag.split('}')[-1]:int(e.text) for e in edge})
        start, end = points
        # The original "改版" caption is longer than its tiny control's box;
        # reserve the otherwise blank space before the adjacent 附图 field.
        if shape_id == '1027': end = {**end, 'col':12, 'colOff':0}
        # In the reviewed template these six legacy mark controls sit one row
        # above their own captions. The static preview aligns their text with
        # UL / date / other-mark captions; native bindings/anchors stay intact.
        adjustment = None
        if shape_id in ('1054','1048','1055','1057','1056','1058'):
            start = {**start, 'row':start['row']+1}
            end = {**end, 'row':end['row']+1}
            adjustment = 'Preview-only one-row alignment with the corresponding printed mark caption.'
        replacement = text_box(shape_id, display, start, end, 850 if shape_id == '1069' else 900)
        pattern = re.compile(r'<mc:AlternateContent\b[^>]*>(?:(?!</mc:AlternateContent>).)*?'
            r'<xdr:cNvPr\b[^>]*\bid="'+shape_id+r'"(?:(?!</mc:AlternateContent>).)*?</mc:AlternateContent>', re.S)
        drawing, count = pattern.subn(lambda _: replacement, drawing)
        if count != 1: raise ValueError('Missing unique fallback anchor for control '+shape_id)
        entries.append({'shapeId':shape_id, 'objectType':kind, 'label':label, 'value':value,
                        'display':display, 'from':start, 'to':end, 'anchorAdjustment':adjustment})
    title_start = {'col':18,'colOff':0,'row':2,'rowOff':0}
    title_end = {'col':30,'colOff':0,'row':3,'rowOff':0}
    title = text_box('9000', '原生控件发布快照  /  正式 XLSX 保留 45 个可编辑原生控件', title_start, title_end, 1100, True)
    drawing = drawing.replace('</xdr:wsDr>', title+'</xdr:wsDr>')
    package[drawing_member] = drawing.encode()
    main = sheets[0]['member']
    xml = package[main].decode()
    xml = re.sub(r'<legacyDrawing\b[^>]*/>', '', xml)
    xml = re.sub(r'<controls>.*?</controls>', '', xml, flags=re.S)
    package[main] = xml.encode()
    _fit_print(package,sheets,'landscape_a3')
    # The second sheet is the dropdown option source, not a second delivery
    # instruction page. Keep it in the XLSX but hide it only in this print copy.
    book = package['xl/workbook.xml'].decode()
    name = re.escape(sheets[1]['name'])
    book = re.sub(r'(<sheet\b(?=[^>]*\bname="'+name+r'")[^>]*?)(/>)', r'\1 state="hidden"\2', book)
    book = re.sub(r'<definedName\b(?=[^>]*\bname="_xlnm.Print_Area")(?=[^>]*\blocalSheetId="1")[^>]*>.*?</definedName>','',book,flags=re.S)
    package['xl/workbook.xml'] = book.encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as out:
        for name,data in package.items(): out.writestr(name,data)
    return buf.getvalue(), {'schemaVersion':1, 'label':'原生控件发布快照', 'sourceWorkbookSha256':_sha(workbook_bytes),
        'controlCount':len(entries), 'controls':entries, 'optionSheetPrinted':False,
        'limitation':'Print-only static text from current ctrlProps at template anchors; this copy has no interactive controls and is not the editable deliverable.'}


def _render(workbook, qa):
    soffice=RUNTIME/'bin/override/soffice';pdftoppm=RUNTIME/'bin/override/pdftoppm'
    if not soffice.exists():
        return {"status":"unavailable","limitation":"No native spreadsheet rendering engine found; OOXML checks do not prove rendered readability."}
    qa.mkdir(parents=True,exist_ok=True)
    fontconfig=qa/'fonts.conf';cache=qa/'font-cache';cache.mkdir(exist_ok=True)
    dirs=[p for p in [Path('/System/Library/Fonts'),Path('/System/Library/Fonts/Supplemental'),Path('/usr/share/fonts')]if p.exists()]
    fontconfig.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'+''.join('<dir>'+escape(str(p))+'</dir>'for p in dirs)+'<cachedir>'+escape(str(cache))+'</cachedir><alias><family>宋体</family><prefer><family>Songti SC</family></prefer></alias><alias><family>楷体_GB2312</family><prefer><family>Kaiti SC</family><family>Songti SC</family></prefer></alias></fontconfig>')
    env=os.environ.copy();env.update({'FONTCONFIG_FILE':str(fontconfig),'XDG_CACHE_HOME':str(cache)})
    native_raw = qa/'native-raw'; native_raw.mkdir(exist_ok=True)
    formal_bytes = workbook.read_bytes()
    snapshot_bytes, snapshot = _control_snapshot_workbook(formal_bytes)
    preview = qa/'原生控件发布快照.xlsx'; preview.write_bytes(snapshot_bytes)
    snapshot_path = qa/'control-snapshot.json'; _json_write(snapshot_path,snapshot)
    with tempfile.TemporaryDirectory(prefix='lo-profile-')as lo:
        def convert(path, directory, preview_only=False):
            # Calc exports a hidden option sheet when its legacy print area is
            # present in some versions. The preview is fitted to one A3 page
            # above; explicitly select that page as a second defence.
            export = 'pdf:calc_pdf_Export:{"PageRange":{"type":"string","value":"1"}}' if preview_only else 'pdf'
            return subprocess.run([str(soffice),'-env:UserInstallation='+Path(lo).as_uri(),'--headless','--convert-to',export,'--outdir',str(directory),str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,env=env)
        raw_result = convert(workbook,native_raw)
        result = convert(preview,qa,True)
    pdf=qa/(preview.stem+'.pdf')
    if result.returncode or not pdf.exists():
        return {'status':'failed','limitation':result.stderr.decode(errors='replace')[-1500:]}
    if workbook.read_bytes() != formal_bytes: raise RuntimeError('Rendering changed the formal native workbook')
    from pypdf import PdfReader
    pages=PdfReader(pdf).pages;chinese=sum(len(re.findall('[\u4e00-\u9fff]',p.extract_text()or''))for p in pages)
    for stale in qa.glob('process-page-*.png'): stale.unlink()
    images=[]
    if pdftoppm.exists():
        for i in range(1,len(pages)+1):
            prefix=qa/f'process-page-{i}'
            r=subprocess.run([str(pdftoppm),'-f',str(i),'-singlefile','-scale-to','2200','-png',str(pdf),str(prefix)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,env=env)
            if r.returncode==0 and prefix.with_suffix('.png').exists():images.append(str(prefix.with_suffix('.png')))
    return {'status':'rendered','pdfPath':str(pdf),'pageCount':len(pages),'chineseExtracted':chinese,'images':images,'visualInspectionRequired':True,
            'previewKind':'native-control-publication-snapshot','snapshotWorkbookPath':str(preview),'snapshotManifestPath':str(snapshot_path),
            'sourceWorkbookSha256':snapshot['sourceWorkbookSha256'],'controlCount':snapshot['controlCount'],
            'nativeRawPdfPath':str(native_raw/(workbook.stem+'.pdf')) if raw_result.returncode==0 else None,
            'limitation':'Native Calc omits legacy form-control captions. The labelled print-only snapshot replaces them with current-state ordinary text; the formal XLSX keeps all 45 editable native controls. Option-source sheet is retained in XLSX but excluded from the preview.'}


def validate_process_requirements(params: dict) -> dict:
    """Independently reopen source/template/output and test observable invariants."""
    source,product,version,date,template,profile,facts,records,outlines=_parameters(params)
    workbook=Path(params['workbookPath']).resolve();data=workbook.read_bytes()
    z,sheets=_xlsx_read(data);tz,tsheets=_xlsx_read(template.read_bytes())
    controls,vml_member=_template_controls(z,sheets);tcontrols,tvml=_template_controls(tz,tsheets)
    checks=[]
    def check(name,passed,actual=None,expected=None):checks.append({'name':name,'passed':bool(passed),'actual':actual,'expected':expected})
    check('two-sheets',len(sheets)==2,len(sheets),2)
    check('sheet-names-preserved',[s['name']for s in sheets]==[s['name']for s in tsheets])
    check('45-native-controls',len(controls)==len(tcontrols)==45,len(controls),45)
    check('bindings-preserved',{k:c['binding']for k,c in controls.items()}=={k:c['binding']for k,c in tcontrols.items()})
    check('styles-byte-identical',z.read('xl/styles.xml')==tz.read('xl/styles.xml'))
    check('drawing-anchors-preserved',all(z.read(n)==tz.read(n)for n in tz.namelist()if n.startswith('xl/drawings/')and n.endswith('.xml')))
    values=sheets[0]['values'];compact=version[1:].replace('.','V')
    check('product-and-version',values.get('C5')==f'{product}-{compact}'and values.get('H5')==compact)
    check('actual-outline-width',type(values.get('E13'))in(int,float)and abs(values['E13']-facts['widthMm'])<.0011,values.get('E13'),facts['widthMm'])
    check('actual-outline-height',type(values.get('I13'))in(int,float)and abs(values['I13']-facts['heightMm'])<.0011,values.get('I13'),facts['heightMm'])
    check('nominal-thickness',values.get('E14')==profile['nominalThicknessMm'],values.get('E14'),profile['nominalThicknessMm'])
    check('nominal-thickness-near-source',not facts['stackThicknessMm'] or type(values.get('E14'))in(int,float)and abs(values['E14']-facts['stackThicknessMm'])<=.15)
    check('readable-publish-summary',f"{facts['layerCount']}层"in str(values.get('B30',''))and profile['surfaceFinish']in str(values.get('B31','')))
    def selected(c):
        sel=int(c['prop'].attrib.get('sel',0));return c['choices'][sel-1]if 1<=sel<=len(c['choices'])else None
    layer=selected(controls['1029']);layer_count=1 if layer=='单面'else 2 if layer=='双面'else int(re.search(r'\d+',str(layer)).group())if re.search(r'\d+',str(layer))else None
    check('layer-control-matches-source',layer_count==facts['layerCount'],layer_count,facts['layerCount'])
    state_errors=[]
    for shape,c in controls.items():
        p=c['prop'].attrib;s=c['state']
        if c['choices']:
            if int(p.get('sel',0))!=int(s.get('Sel',0)):state_errors.append(shape+':selection')
            if not 0<=int(p.get('sel',0))<=len(c['choices']):state_errors.append(shape+':bounds')
        elif (p.get('checked')=='Checked')!=(s.get('Checked')=='1'):state_errors.append(shape+':checked')
    check('ctrlprops-vml-consistent',not state_errors,state_errors)
    finish={'无铅喷锡':'1042','电镀金':'1043','化学沉金':'1044','防氧化':'1045'}[profile['surfaceFinish']]
    active=[s for s in('1042','1043','1044','1045','1046')if controls[s]['prop'].attrib.get('checked')=='Checked']
    check('exclusive-surface-finish',active==[finish],active,[finish])
    check('outer-copper-control',_normalized(selected(controls['1032']))==_normalized(f"{profile['outerCopperOz']:g}oz"))
    if facts['layerCount']>2:check('inner-copper-control',_normalized(selected(controls['1031']))==_normalized(f"{profile['innerCopperOz']:g}oz"))
    else:check('no-fictitious-inner-copper',selected(controls['1031'])in(None,''))
    copper_errors=[]
    for copper in facts['copperThicknessUm']:
        if copper['thicknessUm']<=0:continue
        value=selected(controls['1032'if copper['layerId']in(1,2)else'1031'])
        number=re.search(r'[0-9.]+',str(value))
        expected=min((.5,1,2),key=lambda oz:abs(oz*35-copper['thicknessUm']))
        if not number or float(number.group())!=expected:copper_errors.append({'layerId':copper['layerId'],'selected':value,'expectedNominalOz':expected})
    check('copper-controls-match-source-stack',not copper_errors,copper_errors)
    for shape,key in(('1049','material'),('1069','tg'),('1034','solderMaskColor'),('1036','silkscreenColor')):
        check('profile-'+key,_normalized(selected(controls[shape]))==_normalized(profile[key]))
    targets=_effective_targets(records,profile)
    expected_image,diagram_info=_diagram_bytes(facts,records,outlines,targets,product)
    images=[n for n in z.namelist()if n.startswith('xl/media/')and not n.endswith('/')]
    check('current-source-impedance-picture',len(images)==1 and _sha(z.read(images[0]))==diagram_info['sha256'])
    check('case-picture-not-reused',len(images)==1 and z.read(images[0])!=tz.read(next(n for n in tz.namelist()if n.startswith('xl/media/')and not n.endswith('/'))))
    check('no-stale-third-layer-note','第三层'not in str(values.get('S32','')))
    return {'schemaVersion':1,'passed':all(c['passed']for c in checks),'checks':checks,'workbookPath':str(workbook),'workbookSha256':_sha(data),'sourceSha256':facts['sourceSha256'],'facts':facts,'diagram':diagram_info,'unresolved':[]}


def generate_process_requirements(params: dict) -> dict:
    source,product,version,date,template,profile,facts,records,outlines=_parameters(params)
    root=Path(params['packagePath']).expanduser().resolve()
    # Never write into the golden template package, even when overwrite was set.
    protected=template.parents[2]if template.parent.parent.name=='生产资料'else template.parent
    if root==protected or protected in root.parents:raise ValueError('The golden template package is read-only')
    compact=version[1:].replace('.','V')
    relative=Path(params.get('outputRelativePath',f'生产资料/06_工艺要求/{product}-{compact}-{date.replace("-","")}.xlsx'))
    if relative.is_absolute()or'..'in relative.parts:raise ValueError('outputRelativePath must stay within packagePath')
    workbook=root/relative
    if workbook.exists()and not params.get('overwrite',False):raise FileExistsError(workbook)
    qa=root/'.hdk/process-requirements';qa.mkdir(parents=True,exist_ok=True)
    z,sheets=_xlsx_read(template.read_bytes());controls,vml=_template_controls(z,sheets)
    if len(sheets)!=2 or len(controls)!=45:raise ValueError('Reviewed native manufacturing template is required')
    targets=_effective_targets(records,profile)
    cells,selectors=_edit_plan(facts,profile,product,version,date,controls,targets)
    diagram,diagram_info=_diagram_bytes(facts,records,outlines,targets,product)
    (qa/'impedance-current-source.png').write_bytes(diagram)
    authored=_author_cells(template,cells,qa,params)
    output=_preserve_template(template.read_bytes(),authored,selectors,diagram,profile)
    workbook.parent.mkdir(parents=True,exist_ok=True);workbook.write_bytes(output)
    validation=validate_process_requirements({**params,'profile':profile,'workbookPath':str(workbook)})
    fields=[
        {'field':'outline','value':{'widthMm':facts['widthMm'],'heightMm':facts['heightMm']},'source':'source PCB layer11 geometry; centerline bounds','classification':'source'},
        {'field':'layers','value':facts['copperLayers'],'source':'enabled source copper LAYER records','classification':'source'},
        {'field':'physicalStack','value':facts['physicalStack'],'source':'source LAYER_PHYS; mil converted to mm/um','classification':'source'},
        {'field':'nominalThicknessMm','value':profile['nominalThicknessMm'],'source':'manufacturing profile nominal; source sum '+str(round(facts['stackThicknessMm'],6))+'mm','classification':'profile'},
        {'field':'material','value':profile['material'],'source':'source explicit FR4'if facts['materialExplicitFr4']else'reference manufacturing profile; laminate labels retained in stack','classification':'source'if facts['materialExplicitFr4']else'profile'},
        {'field':'impedanceTargets','value':targets,'source':'current source net geometry + protocol design targets; no measured impedance claim','classification':'target'},
    ]
    for key in('solderMaskColor','silkscreenColor','surfaceFinish','tg','innerCopperOz','outerCopperOz','electricalTest','viaMask','ulMark','manufactureDateMark','dateCode','orderQuantity','deliveryDate'):
        fields.append({'field':key,'value':profile[key],'source':'explicit profile'if key in(params.get('profile')or{})else'reference manufacturing profile default','classification':'profile'})
    unresolved=[{'field':'fabricatorStackupAndCoupon','severity':'manufacturing-confirmation','detail':'Targets and nominal stack are specified. Fabricator must confirm its realized stack/coupon; this is not a missing HDK file or an impedance measurement.'}]
    if not facts['versions']:unresolved.append({'field':'sourceHardwareVersion','severity':'review','detail':'Source has no explicit Version; requested hardwareVersion used.'})
    rendered=_render(workbook,qa)if params.get('render',True)else{'status':'skipped','limitation':'Native visual rendering was not requested; no visual-readability claim.'}
    report={'schemaVersion':1,'source':facts,'profile':profile,'profileSchema':PROFILE_SCHEMA,'fields':fields,'unresolved':unresolved,'diagram':diagram_info,'cellEdits':cells,'controlEdits':selectors,'nativeValidation':validation,'render':rendered,'authoring':'Artifact Tool cell authoring + deterministic native-control preservation'}
    report_path=qa/'fields.json';_json_write(report_path,report);_json_write(qa/'validation.json',validation)
    if not validation['passed']:raise RuntimeError('Independent process workbook validation failed; see '+str(qa/'validation.json'))
    return {'schemaVersion':1,'status':'completed','workbookPath':str(workbook),'fieldsReportPath':str(report_path),'artifacts':[{'kind':'process-requirements','path':str(workbook),'sha256':_sha(output)}],'facts':facts,'profile':profile,'validation':validation,'render':rendered,'unresolved':unresolved}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('operation',choices=['prepare','generate','validate']);parser.add_argument('params',help='Path to JSON parameters')
    args=parser.parse_args();params=json.loads(Path(args.params).read_text())
    fn={'prepare':prepare_process_request,'generate':generate_process_requirements,'validate':validate_process_requirements}[args.operation]
    print(json.dumps(fn(params),ensure_ascii=False,indent=2))


if __name__=='__main__':main()
