
#!/bin/bash
#
# Renumber Banter categories and phrases.
#
# - Categories are renumbered in their current display order.
# - Bucket keeps its special category ID "10".
# - Phrase IDs restart at 001 in each category.
# - Bucket phrase IDs keep the special "bu-" prefix.
# - All JSON files are backed up before any changes are written.
#
# Run manually when Banter is not being edited on another device.

set -euo pipefail

cd "$(dirname "$0")"

python3 <<'PYTHON'
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

data_dir = Path("data")
categories_file = data_dir / "categories.json"

def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)

# Load and validate the category list before changing anything.
try:
    categories = json.loads(categories_file.read_text(encoding="utf-8"))
except Exception as error:
    fail(f"Cannot read categories.json: {error}")

if not isinstance(categories, list):
    fail("categories.json must contain a list.")

bucket_entries = [
    category for category in categories
    if category.get("file") == "bucket.json"
]

if len(bucket_entries) != 1 or bucket_entries[0].get("id") != "10":
    fail('Expected exactly one Bucket with ID "10". Nothing changed.')

# Keep the special Bucket ID fixed; other categories use 01, 02, etc.
regular_categories = [
    category for category in categories
    if category["file"] != "bucket.json"
]

if len(regular_categories) > 9:
    fail("Too many regular categories for this numbering scheme.")

files_to_write = {}
new_categories = []

# Prepare the updated category list and every phrase file in memory.
for number, category in enumerate(regular_categories, start=1):
    category = dict(category)
    category["id"] = f"{number:02d}"
    new_categories.append(category)

new_categories.append(dict(bucket_entries[0]))

# Keep the existing category display order, including Bucket's position.
# Replace each regular category in its original position.
regular_iter = iter(new_categories[:-1])
final_categories = [
    dict(bucket_entries[0]) if item["file"] == "bucket.json"
    else next(regular_iter)
    for item in categories
]

for category in final_categories:
    phrase_file = data_dir / category["file"]

    try:
        phrases = json.loads(phrase_file.read_text(encoding="utf-8"))
    except Exception as error:
        fail(f"Cannot read {phrase_file}: {error}")

    if not isinstance(phrases, list):
        fail(f"{phrase_file} must contain a list.")

    prefix = "bu" if category["file"] == "bucket.json" else category["id"]

    for number, phrase in enumerate(phrases, start=1):
        if not isinstance(phrase, dict) or not isinstance(phrase.get("text"), str):
            fail(f"Invalid phrase in {phrase_file}. Nothing changed.")

        if number > 999:
            fail(f"{phrase_file} has more than 999 phrases.")

        phrase["id"] = f"{prefix}-{number:03d}"

    files_to_write[phrase_file] = (
        json.dumps(phrases, indent=4, ensure_ascii=False) + "\n"
    )

files_to_write[categories_file] = (
    json.dumps(final_categories, indent=4, ensure_ascii=False) + "\n"
)

# Back up all files first. Do not write anything if a backup fails.
backup_dir = data_dir / (
    "backup-renumber-" + datetime.now().strftime("%Y%m%d-%H%M%S")
)

try:
    backup_dir.mkdir()
    for path in files_to_write:
        shutil.copy2(path, backup_dir / path.name)
except Exception as error:
    fail(f"Backup failed: {error}. No JSON files have been changed.")

# Stage every replacement before installing any of them.
staged = {}

try:
    for path, content in files_to_write.items():
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=data_dir,
            delete=False
        ) as temp:
            temp.write(content)
            staged[path] = Path(temp.name)

    for path, temp_path in staged.items():
        os.replace(temp_path, path)

except Exception as error:
    # Restore every original file from the backup if installation fails.
    print(f"ERROR writing files: {error}. Restoring backups.", file=sys.stderr)
    for path in files_to_write:
        backup = backup_dir / path.name
        if backup.exists():
            shutil.copy2(backup, path)
    fail(f"Restore attempted. Check the files and backup at {backup_dir}.")

finally:
    for temp_path in staged.values():
        if temp_path.exists():
            temp_path.unlink()

print("Banter IDs successfully renumbered.")
print(f"Backup: {backup_dir}")
print(f"Categories: {len(final_categories)}")
for category in final_categories:
    print(f"  {category['id']}  {category['name']} ({category['file']})")
PYTHON
