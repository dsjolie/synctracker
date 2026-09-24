"""Index a folder of tracker modules for SyncTracker's library panel.

Walks the folder (subfolders included, following junctions) and writes index.json into it:
a tree of folders and module files with URLs relative to the index. The app loads
mods/index.json by default, or ?library=<url of index.json>. Re-run after adding, moving or
renaming modules.

    python tools/index-mods.py [folder]      (default: mods/, next to index.html)
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import quote

# Formats libopenmpt plays that are common in module collections.
EXTENSIONS = {
    'mod', 's3m', 'xm', 'it', 'mptm', 'mo3', '669', 'mtm', 'med', 'okt', 'stm', 'far', 'ult',
    'dmf', 'amf', 'psm', 'umx', 'ams', 'dbm', 'dsm', 'mdl', 'j2b', 'ptm', 'gdm', 'imf',
}


def is_module(name):
    if '.' not in name:
        return False
    lower = name.lower()
    # Amiga-style names put the format first: mod.songname
    return lower.rsplit('.', 1)[1] in EXTENSIONS or lower.startswith('mod.')


def index_folder(folder, rel_parts):
    """The tree for one folder, or None if it holds no modules at any depth."""
    dirs, files = [], []
    for entry in sorted(os.scandir(folder), key=lambda e: e.name.lower()):
        if entry.name.startswith('.'):
            continue  # hidden files and folders; static servers often refuse dot paths
        if entry.is_dir():
            sub = index_folder(entry.path, rel_parts + [entry.name])
            if sub:
                dirs.append(sub)
        elif entry.is_file() and is_module(entry.name):
            url = '/'.join(quote(part) for part in rel_parts + [entry.name])
            files.append({'name': entry.name, 'url': url, 'size': entry.stat().st_size})
    if not dirs and not files:
        return None
    return {'name': rel_parts[-1] if rel_parts else '', 'dirs': dirs, 'files': files}


def count(tree):
    return len(tree['files']) + sum(count(d) for d in tree['dirs'])


def main():
    default = Path(__file__).resolve().parent.parent / 'mods'
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else default
    tree = index_folder(root, []) or {'name': '', 'dirs': [], 'files': []}
    out = root / 'index.json'
    out.write_text(json.dumps(tree, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{count(tree)} modules indexed in {out}')


if __name__ == '__main__':
    main()
