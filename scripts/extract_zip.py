"""Safely extract a small source ZIP for a local Docker build."""
import stat
import sys
import zipfile
from pathlib import Path

archive, destination = sys.argv[1:]
root = Path(destination).resolve()
root.mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if len(entries) > 3000 or sum(item.file_size for item in entries) > 100 * 1024 * 1024:
        raise ValueError("ZIP contains too many files or exceeds 100 MB expanded")
    for item in entries:
        path = Path(item.filename)
        lowered = [part.lower() for part in path.parts]
        if any(part in {".env", ".aws", ".ssh", ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519"} or part.startswith(".env.") or part.endswith((".pem", ".key", ".p12", ".pfx")) for part in lowered):
            raise ValueError("ZIP contains a credential or environment file")
        mode = item.external_attr >> 16
        target = (root / path).resolve()
        if (path.is_absolute() or ".." in path.parts or "\\" in item.filename or not target.is_relative_to(root)):
            raise ValueError("Unsafe ZIP path")
        if stat.S_ISLNK(mode):
            raise ValueError("ZIP symlinks are not allowed")
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
            raise ValueError("Unsupported ZIP entry")
        target.parent.mkdir(parents=True, exist_ok=True)
        extracted = 0
        with source.open(item) as reader, open(target, "wb") as writer:
            while chunk := reader.read(1024 * 1024):
                extracted += len(chunk)
                if extracted > 100 * 1024 * 1024:
                    raise ValueError("ZIP entry exceeds expanded size limit")
                writer.write(chunk)
