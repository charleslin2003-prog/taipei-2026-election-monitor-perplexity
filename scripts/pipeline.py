import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

from collect import collect, validate_events, validate_profiles, validate_reviews

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "site/data/news.json"


def run(*args, text=None, check=True):
    return subprocess.run(args, cwd=ROOT, input=text, text=True,
                          capture_output=True, check=check)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def restore_remote():
    result = run("git", "ls-remote", "--exit-code", "origin",
                 "refs/heads/tracker-data", check=False)
    if result.returncode == 2:
        return None, read_json(STATE)
    if result.returncode != 0:
        raise RuntimeError("Unable to verify remote data branch; refusing empty state")

    run("git", "fetch", "--depth=1", "origin", "tracker-data")
    parent = run("git", "rev-parse", "FETCH_HEAD").stdout.strip()
    raw = run("git", "show", f"{parent}:state.json").stdout
    payload = json.loads(raw)
    if (payload.get("version") != 1 or not isinstance(payload.get("articles"), list)
            or not isinstance(payload.get("feeds"), dict)):
        raise ValueError("Remote data is corrupt; refusing to overwrite")
    return parent, payload


def save_remote(parent, content):
    blob = run("git", "hash-object", "-w", "--stdin", text=content).stdout.strip()
    tree = run("git", "mktree", text=f"100644 blob {blob}\tstate.json\n").stdout.strip()
    if parent:
        old_tree = run("git", "rev-parse", f"{parent}^{{tree}}").stdout.strip()
        if old_tree == tree:
            return

    command = ["git", "-c", "user.name=github-actions[bot]",
               "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
               "commit-tree", tree]
    if parent:
        command += ["-p", parent]
    commit = run(*command, text="data: update public news metadata\n").stdout.strip()
    run("git", "push", "origin", f"{commit}:refs/heads/tracker-data")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()

    reviews = read_json(ROOT / "reviews.json")
    events = read_json(ROOT / "events.json")
    profiles = read_json(ROOT / "profiles.json")
    validate_reviews(reviews)
    validate_events(events)
    validate_profiles(profiles)

    if args.local:
        parent, previous = None, read_json(STATE)
    else:
        parent, previous = restore_remote()

    result = collect(previous)
    result["repository"] = os.environ.get(
        "GITHUB_REPOSITORY", previous.get("repository", "")
    )
    content = json.dumps(result, ensure_ascii=False, indent=2) + "\n"

    if not args.local:
        save_remote(parent, content)

    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(STATE)
    shutil.copyfile(ROOT / "reviews.json", ROOT / "site/data/reviews.json")
    shutil.copyfile(ROOT / "events.json", ROOT / "site/data/events.json")
    shutil.copyfile(ROOT / "profiles.json", ROOT / "site/data/profiles.json")
    (ROOT / "site/.nojekyll").touch()
    print(json.dumps({
        "status": result["status"],
        "articles": len(result["articles"]),
        "feeds": {key: item["status"] for key, item in result["feeds"].items()}
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
