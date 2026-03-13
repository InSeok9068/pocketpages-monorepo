# pocketbase-importer

Small, fast, external-dependency-free CLI tool to bulk-import CSV files into **PocketBase** collections.

Handles large files, messy CSVs, missing values.

## Features

- Efficient parallel processing (configurable number of goroutines)
- Good handling of problematic CSVs:
  - multiline quoted values
  - custom delimiters
  - irregular number of columns
- Creates missing IDs/field values automatically when PocketBase is configured to auto-generate them
- Skips "unique constraint" errors by default (useful when re-running imports)
- Real-time progress: shows processed rows + rows/second
- No external dependencies besides PocketBase itself
- Optional record validation before insert (`-validate=true/false`) (*Note*: will slow down import speed)

## Requirements

- Go 1.25.5+ (only if building yourself)
- PocketBase v0.36+ compatible data directory

## Installation

### Option 1: Use prebuilt binaries (recommended)

Download from [GitHub Releases](https://github.com/jim-ww/pocketbase-importer/releases)

Available for:
- Linux (amd64, arm64)
- macOS (amd64, arm64)
- Windows (amd64)

### Option 2: Build from source

```bash
go install github.com/jim-ww/pocketbase-importer@latest
```

## Usage
```bash
pocketbase-importer \
  -dataDir ./pb_data \
  -collection users \
  -i users.csv \
  [flags]
```

### Required flags
- `-dataDir`       PocketBase data directory (default: `./pb_data`)
- `-collection`    Target collection name or ID
- `-i`             Input CSV file path

### Important optional flags

| Flag          | Default | Description                                                  |
|---------------|---------|--------------------------------------------------------------|
| `-goroutines` | 100     | Max concurrent insert operations                             |
| `-validate`   | true    | Run PocketBase validation rules before saving                |
| `-delimiter`  | ,       | CSV field delimiter (e.g. `;` `|` `\t`)                      |
| `-printDelay` | 1s      | How often to refresh the progress line                       |

### Example – large file

```bash
pocketbase-importer -dataDir ./pb_data/ -collection customers -i customers-export.csv -goroutines=250 -validate=false -printDelay=2s
```

### Example output:
```text
Processed: 53482 rows | 7473.2 rows/sec (finished)
Import completed successfully.
```

## Important Notes

- CSV **must** contain a header row
- Header names must match PocketBase field names (case-sensitive)
- Empty values are passed as-is → PocketBase applies defaults and auto-generates IDs when configured
- "Value must be unique" errors are silently skipped
- Very wide rows or extremely long values may increase memory usage
