#!/usr/bin/env python3
"""Exports the whole Python course to core/full.js, so every task in the prototype opens its real content.
Run: uv run --no-project --with pyyaml python tools/export_course.py"""
import json, pathlib, re, yaml
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT.parent.parent / "packages/learning/courses/python"
links = {}
raw = (ROOT / "course.js").read_text(encoding="utf-8")
for t in json.loads(raw[raw.index("["):raw.rindex("]") + 1]):
    for i in t["items"]:
        links[i["id"]] = i["links"]

def question(q, topic):
    if any(s.get("rubric") for s in q["slots"]):
        return None  # open questions need a model to grade
    out = {k: q[k] for k in ("id", "body", "slots", "explanation") if k in q}
    if q.get("data"):
        out["datasets"] = [topic["data"][name] for name in q["data"]]
    return out

course = yaml.safe_load((SRC / "course.yaml").read_text(encoding="utf-8"))
topics = []
for path in sorted((SRC / "topics").glob("*.yaml")):
    t = yaml.safe_load(path.read_text(encoding="utf-8"))
    kps = []
    for k in t["kps"]:
        example = k["card"].get("example") or {}
        k["card"]["example"] = example.get("text", "")
        # A card is read long after the lesson, so its example carries the tables it talks about.
        names = list(next((e["example"].get("data", []) for e in t["kps"] if e["example"]["id"] == example.get("from")), []))
        for mark in re.findall(r"表\s?([A-Za-z]\w*)", k["card"]["example"]):
            if mark in t.get("data", {}) and mark not in names:
                names.append(mark)
        k["card"]["datasets"] = [t["data"][n] for n in names]
        kps.append({
            "id": k["id"], "title": k["title"], "key": k.get("keyPrerequisites", []), "links": links.get(k["id"], []), "card": k["card"],
            "lesson": k["lesson"], "example": question(k["example"], t),
            **{name: [x for x in (question(q, t) for q in k[name]) if x] for name in ("practice", "review", "quiz")},
        })
    topics.append({"id": t["id"], "title": t["title"], "summary": t["summary"], "minutes": t["minutes"], "prereq": t["prerequisites"], "intro": t["intro"], "wrapup": t["wrapup"], "kps": kps})
out = {"id": course["id"], "title": course["title"], "summary": course["summary"], "topics": topics}
(ROOT / "core/full.js").write_text("window.FULL = " + json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str) + ";\n", encoding="utf-8")
print(len(topics), "topics", sum(len(t["kps"]) for t in topics), "kps", (ROOT / "core/full.js").stat().st_size // 1024, "KB")
