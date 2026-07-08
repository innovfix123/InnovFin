# Running this project on a new laptop

## What runs where (important)
- **Gmail cloud (not this laptop):** the imported filters + forwarding that actually route
  invoice emails from `sat211053@gmail.com` / `satyamsahu0877@gmail.com` into
  `satyam@innovfix.in`. **This keeps working regardless of your laptop.**
- **This laptop (the project files):** the Python **Invoice Filter** (the brain), the unit
  tests, and the **generator** that produces `gmail_filters.xml`. You only need this when you
  want to change/retest the rules or regenerate the Gmail filters.
- You do **NOT** need Claude installed to *run* the project — only **Python**.

## Prerequisites on the new machine
1. Install **Python 3.11 or newer** (3.13 recommended) from https://www.python.org/downloads/
   - On Windows, tick **"Add Python to PATH"** during install.
2. (Optional) A terminal: PowerShell (Windows) or Terminal (macOS/Linux).

## Step 1 — Copy the project
Move the whole **`invoce_byfilter`** folder to the new machine (USB drive, Google Drive,
OneDrive, or the zip in your home folder). Nothing secret is stored in it — safe to copy.
`config/mailboxes.yaml` only references environment-variable *names*, never passwords.

## Step 2 — Install dependencies
Open a terminal **inside the project folder** and run:
```
pip install -r requirements.txt
```
(Only PyYAML + pandas + pytest — all standard, no OCR/DB/cloud packages.)

## Step 3 — Verify it works
```
python -m pytest            # expect: 78 passed
python cli.py config-check  # validates configuration
python cli.py classify      # runs the filter on built-in sample emails (8/8 routing)
```

## Step 4 — Regenerate the Gmail filters (whenever you change rules)
```
python cli.py gmail-export --out gmail_filters.xml
python cli.py gmail-eval    # precision/recall of the native rules on the samples
```
Then re-import `gmail_filters.xml` into each source Gmail account
(Settings → Filters and Blocked Addresses → Import filters).

## Command reference
| Command | Purpose |
|---------|---------|
| `python -m pytest` | Run the full unit-test suite |
| `python cli.py config-check` | Validate + summarize configuration |
| `python cli.py classify` | Classify the built-in demo emails (or `--file x.eml`) |
| `python cli.py gmail-export` | Generate the importable Gmail filters XML + setup steps |
| `python cli.py gmail-eval` | Measure the native rules against labeled samples |

## Recommended: back it up with Git/GitHub
This also protects you from future laptop changes:
```
cd invoce_byfilter
git init
git add .
git commit -m "Enterprise Invoice Email Gateway - Phase 1"
# create a PRIVATE repo on github.com, then:
git remote add origin https://github.com/<you>/invoice-email-gateway.git
git branch -M main
git push -u origin main
```
On the next machine: `git clone <that URL>` → then Steps 2–3 above.
