#!/usr/bin/env bash
# Move fully completed tasks from one markdown checklist to another.
#
# Usage: archive-tasks.sh [-n|--dry-run] <source.md> <target.md>
#
# A task is a top-level checkbox item ("- [x] ...") together with everything
# indented below it (subtasks, notes, plan bullets). It is moved only when the
# item itself and every checkbox inside it are checked. Moved tasks are placed
# under the same heading path in the target ("# Chat" > "## status"); missing
# headings are created. Source headings are kept even if they become empty.

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [-n|--dry-run] <source.md> <target.md>" >&2
  exit 2
}

dry_run=0
args=()
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) dry_run=1 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *) args+=("$arg") ;;
  esac
done
[ "${#args[@]}" -eq 2 ] || usage

src=${args[0]}
dst=${args[1]}
[ -f "$src" ] || { echo "source not found: $src" >&2; exit 1; }
[ -e "$dst" ] && [ ! -f "$dst" ] && { echo "target is not a file: $dst" >&2; exit 1; }
[ "$(realpath "$src")" != "$(realpath -m "$dst")" ] || { echo "source and target are the same file" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Shared helpers: line classification and indentation (tab = 4 columns).
common='
function rtrim(s) { sub(/[ \t]+$/, "", s); return s }
function trim(s) { sub(/^[ \t]+/, "", s); return rtrim(s) }
function indent(s,   i, c, w) {
  w = 0
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == " ") w++
    else if (c == "\t") w += 4
    else break
  }
  return w
}
function is_blank(s) { return s ~ /^[ \t]*$/ }
function is_heading(s) { return s ~ /^#+[ \t]/ }
function heading_level(s) { match(s, /^#+/); return RLENGTH }
function is_item(s) { return s ~ /^[ \t]*[-*+][ \t]/ }
function is_box(s) { return s ~ /^[ \t]*[-*+][ \t]+\[[ xX]\]/ }
function is_checked(s) { return s ~ /^[ \t]*[-*+][ \t]+\[[xX]\]/ }
function is_fence(s) { return s ~ /^[ \t]*(```|~~~)/ }
'

# Pass 1: split the source into kept lines and moved blocks.
# Moved blocks are written as "@@PATH <heading>\037<heading>..." + block lines.
awk -v kept="$tmp/src.new" -v moved="$tmp/moved" -v summary="$tmp/summary" "$common"'
{
  if (sub(/\r$/, "")) crlf = 1
  L[++n] = $0
}
END {
  fence = 0
  for (i = 1; i <= n; i++) {
    if (is_fence(L[i])) { fence = !fence; F[i] = 1 }
    else F[i] = fence
  }

  depth = 0
  count = 0
  printf "" > moved
  printf "" > summary
  i = 1
  while (i <= n) {
    if (!F[i] && is_heading(L[i])) {
      lvl = heading_level(L[i])
      while (depth > 0 && HL[depth] >= lvl) depth--
      depth++
      HL[depth] = lvl
      HT[depth] = trim(L[i])
      i++
      continue
    }
    if (F[i] || !is_item(L[i])) { i++; continue }

    # Subtree: following lines indented deeper than the item; blank lines
    # belong to it only if more indented content follows.
    base = indent(L[i])
    last = i
    for (j = i + 1; j <= n; j++) {
      if (is_blank(L[j])) continue
      if (!F[j] && is_heading(L[j])) break
      if (indent(L[j]) <= base) break
      last = j
    }

    done = is_checked(L[i])
    for (j = i + 1; done && j <= last; j++)
      if (!F[j] && is_box(L[j]) && !is_checked(L[j])) done = 0

    if (done) {
      path = ""
      for (d = 1; d <= depth; d++) path = path (d > 1 ? "\037" : "") HT[d]
      print "@@PATH " path > moved
      for (j = i; j <= last; j++) { print L[j] > moved; DEL[j] = 1 }
      label = ""
      for (d = 1; d <= depth; d++) label = label (d > 1 ? " > " : "") HT[d]
      print (label == "" ? "" : label " :: ") trim(L[i]) > summary
      count++
    }
    i = last + 1
  }

  eol = crlf ? "\r" : ""
  printf "" > kept
  for (i = 1; i <= n; i++) if (!DEL[i]) print L[i] eol > kept
  close(kept); close(moved); close(summary)
  print count
}
' "$src" > "$tmp/count"

count=$(cat "$tmp/count")
if [ "$count" -eq 0 ]; then
  echo "nothing to archive: no fully checked tasks in $src"
  exit 0
fi

echo "$count task(s) from $src -> $dst:"
sed 's/^/  /' "$tmp/summary"

if [ "$dry_run" -eq 1 ]; then
  echo "(dry run, no files changed)"
  exit 0
fi

[ -f "$dst" ] || : > "$dst"

# Pass 2: insert moved blocks into the target under their heading path.
awk -v out="$tmp/dst.new" "$common"'
function insert_at(p, line,   k) {
  for (k = m; k >= p; k--) T[k + 1] = T[k]
  T[p] = line
  m++
}
function next_heading(from, to, maxlvl,   k) {
  for (k = from; k < to; k++)
    if (is_heading(T[k]) && (maxlvl == 0 || heading_level(T[k]) <= maxlvl)) return k
  return to
}
function place(path, first, last,   c, k, lo, hi, h, lvl, found, p, b) {
  c = split(path, P, "\037")
  if (path == "") c = 0
  lo = 1; hi = m + 1
  for (k = 1; k <= c; k++) {
    lvl = heading_level(P[k])
    found = 0
    for (h = lo; h < hi; h++)
      if (is_heading(T[h]) && trim(T[h]) == P[k]) { found = h; break }
    if (!found) {
      # Create the heading at the end of the current scope.
      p = hi
      while (p > lo && is_blank(T[p - 1])) p--
      if (p > 1 && !is_blank(T[p - 1])) { insert_at(p, ""); p++; hi++ }
      insert_at(p, P[k]); hi++
      if (p < m && !is_blank(T[p + 1])) { insert_at(p + 1, ""); hi++ }
      found = p
    }
    lo = found + 1
    hi = next_heading(lo, hi, lvl)
  }
  # Append after the section own content, before any subheading.
  p = next_heading(lo, hi, 0)
  while (p > lo && is_blank(T[p - 1])) p--
  for (b = first; b <= last; b++) insert_at(p++, B[b])
  if (p <= m && is_heading(T[p])) insert_at(p, "")
}
FNR == NR {
  if ($0 ~ /^@@PATH /) { BP[++blocks] = substr($0, 8); BF[blocks] = nb + 1; next }
  B[++nb] = $0
  BL[blocks] = nb
  next
}
{
  if (sub(/\r$/, "")) crlf = 1
  T[++m] = $0
}
END {
  for (k = 1; k <= blocks; k++) place(BP[k], BF[k], BL[k])
  eol = crlf ? "\r" : ""
  printf "" > out
  for (k = 1; k <= m; k++) print T[k] eol > out
  close(out)
}
' "$tmp/moved" "$dst"

# Write the target first: if anything fails afterwards, tasks are duplicated, never lost.
cat "$tmp/dst.new" > "$dst"
cat "$tmp/src.new" > "$src"
echo "done."
