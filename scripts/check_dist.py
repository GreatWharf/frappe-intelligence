"""Check complete runtime resources and secret-free release metadata in both archives."""

import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "frappe_intelligence"
SUFFIXES = {".py", ".json", ".js", ".txt", ".svg", ".png", ".css", ".html", ".md"}


def main():
    expected = {
        str(path.relative_to(ROOT))
        for path in (ROOT / PACKAGE).rglob("*")
        if path.is_file() and path.suffix in SUFFIXES
    }
    wheels = list((ROOT / "dist").glob("*.whl"))
    sources = list((ROOT / "dist").glob("*.tar.gz"))
    if len(wheels) != 1 or len(sources) != 1:
        raise SystemExit("Build into a clean dist directory: expected one wheel and one source archive.")
    for path in (wheels[0], sources[0]):
        if path.suffix == ".whl":
            with zipfile.ZipFile(path) as archive:
                contents = set(archive.namelist())
        else:
            with tarfile.open(path) as archive:
                contents = {name.partition("/")[2] for name in archive.getnames()}
        missing = expected - contents
        if missing:
            raise SystemExit(f"{path.name} is missing runtime files: {sorted(missing)}")
        if any("node_modules/" in name or "/.env" in name or "auth.json" in name for name in contents):
            raise SystemExit("Unexpected dependency cache or credential-shaped file in distribution.")
    print(f"Verified {len(expected)} runtime resources in wheel and source archive.")


if __name__ == "__main__":
    main()
