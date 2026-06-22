#!/usr/bin/env bash

# Visual terminal glyph-rendering check for Restty (or any other emulator).
# Run this inside the terminal being tested; no external commands are required.

set -u

usage() {
  cat <<'EOF'
Usage: scripts/check-terminal-glyphs.sh [--no-color]

Prints alignment rulers, block/box characters, Powerline separators, Nerd Font
icons, and Unicode width samples. Look for gaps, clipping, oversized icons, or
colored pixels leaking into the following line.
EOF
}

color=1
case "${1:-}" in
  --no-color) color=0 ;;
  -h|--help) usage; exit 0 ;;
  '') ;;
  *) usage >&2; exit 2 ;;
esac

if [[ $color -eq 1 ]]; then
  reset=$'\033[0m'
  bold=$'\033[1m'
  dim=$'\033[2m'
  cyan=$'\033[38;5;81m'
  muted=$'\033[38;5;244m'
else
  reset=''
  bold=''
  dim=''
  cyan=''
  muted=''
fi

section() {
  printf '\n%s%s%s\n' "$bold$cyan" "$1" "$reset"
}

printf '%sTerminal glyph rendering check%s\n' "$bold" "$reset"
printf '%sEvery │…│ sample should align; icons should fit one cell unless noted.%s\n' "$muted" "$reset"

section '1. Cell spacing and baseline'
printf '%s\n' '         1         2         3         4         5         6         7'
printf '%s\n' '1234567890123456789012345678901234567890123456789012345678901234567890'
printf '%s\n' '│MMMMMMMMMM│iiiiiiiiii│0000000000│..........│__________│'
printf '%s\n' '│ABCDEFGHIJ│abcdefghij│0123456789│()[]{}<>!?│~=+-*/\\|:│'
printf '%s\n' 'baseline:   Hpqgjy  Hpqgjy  Hpqgjy  Hpqgjy'

section '2. Box drawing (all joins should be continuous)'
printf '%s\n' '┌──────────┬──────────┐  ╭──────────╮'
printf '%s\n' '│ light    │ vertical │  │ rounded  │'
printf '%s\n' '├──────────┼──────────┤  ╰──────────╯'
printf '%s\n' '│          │          │  ┏━━━━━━━━━━┓'
printf '%s\n' '└──────────┴──────────┘  ┗━━━━━━━━━━┛'
printf '%s\n' '╔══════════╦══════════╗  ╱╲╳╱╲'
printf '%s\n' '╚══════════╩══════════╝  ╲╱╳╲╱'

section '3. Block elements (no gaps between adjacent cells)'
printf '%s\n' 'shades:     │░░▒▒▓▓██│'
printf '%s\n' 'vertical:   │▁▂▃▄▅▆▇█│'
printf '%s\n' 'horizontal: │▏▎▍▌▋▊▉█│'
printf '%s\n' 'halves:     │▀▀▄▄▌▌▐▐│'
if [[ $color -eq 1 ]]; then
  printf '\033[48;5;25m\033[38;5;81m████████\033[48;5;81m\033[38;5;25m████████%s  solid color join\n' "$reset"
fi

section '4. Powerline separators'
printf '%s\n' 'plain:      ││  each separator should occupy one cell'
if [[ $color -eq 1 ]]; then
  printf '\033[48;5;167m\033[38;5;232m   esko \033[38;5;167m\033[48;5;222m\033[38;5;232m ~/src \033[38;5;222m\033[48;5;110m\033[38;5;232m  main \033[38;5;110m\033[49m%s\n' "$reset"
  printf '\033[48;5;25m\033[38;5;231m LEFT \033[38;5;25m\033[48;5;81m\033[38;5;232m MIDDLE \033[38;5;81m\033[48;5;213m\033[38;5;232m RIGHT \033[38;5;213m\033[49m%s\n' "$reset"
  printf '%s%sNo colored pixels should appear on this line.%s\n' "$dim" "$muted" "$reset"
else
  printf '%s\n' 'color check skipped (--no-color)'
fi

section '5. Nerd Font icons (each should fit between its bars)'
printf '%s\n' 'system: ││ │ │  folders: ││ │ │'
printf '%s\n' 'files:  ││ │ │  places:  ││ │ │'
printf '%s\n' 'tools:  ││ │ │  status:  ││ │ │'
printf '%s\n' 'mixed:  │AB│ │AB│ │AB│ │AB│  icons should not touch rows above/below'

section '6. Unicode width and shaping'
printf '%s\n' 'arrows:     → ← ↑ ↓ ⇒ ⇐ ↔ ↕  => -> <- != <= >='
printf '%s\n' 'math:       ± × ÷ ≠ ≤ ≥ ∞ √ ∑ ∫ λ π'
printf '%s\n' 'combining:  │é│é│â│ö│  precomposed and combining marks should align'
printf '%s\n' 'wide:       │漢字│かな│한글│  wide glyphs should consume two cells each'
printf '%s\n' 'braille:    │⣿⣷⣯⣟⡿⢿⣻⣽│'

printf '\n%sDone.%s Resize the window and run again if the defect is size-dependent.\n' "$bold" "$reset"
