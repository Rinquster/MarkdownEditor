#!/usr/bin/env bash
# Пересобирает fonts/ из fonts-original/, оставляя в файлах только те символы,
# которые проекту действительно нужны: латиница, кириллица, типографика,
# стрелки, математика, псевдографика и галочки.
#
# Зачем: три начертания Lato в полном виде — 620 КБ из примерно 840 КБ первой
# загрузки, а латиницы с кириллицей там меньше десятой части глифов.
#
# Нужен fontTools с поддержкой woff2 (модуль brotli):
#   pip install fonttools brotli
# В системах с PEP 668 (Debian/Ubuntu) — в отдельный каталог, без записи в систему:
#   pip install --target=/tmp/fontlib fonttools
#   PYTHONPATH=/tmp/fontlib tools/subset-fonts.sh
#
# Запускать только по fonts-original/: субсеттинг необратим, повторный прогон
# по уже урезанным файлам будет отрезать всё больше.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=fonts-original
DST=fonts

# Что оставляем: базовая латиница и Latin-1, Latin Extended-A (европейские
# диакритики), комбинируемые знаки, греческий (нужен для математики), кириллица
# с расширением, общая пунктуация, надстрочные и валюты, буквоподобные (№, ™),
# дроби, стрелки, математические операторы, псевдографика и геометрия (маркеры
# списков), галочки (в справке есть ✓) и латинские лигатуры.
#
# Что сознательно НЕ берём: Latin Extended-B и IPA, вьетнамскую Latin Extended
# Additional, технические и прочие символы — на них уходила половина веса Lato,
# а в текстах этого проекта они не встречаются.
RANGES='U+0000-00FF,U+0100-017F,U+0300-036F,U+0370-03FF,U+0400-04FF,U+0500-052F,\
U+2000-206F,U+2070-209F,U+20A0-20BF,U+2100-214F,U+2150-218F,U+2190-21FF,\
U+2200-22FF,U+2500-257F,U+25A0-25FF,U+2713-2718,U+FB00-FB06,U+FEFF,U+FFFD'

if ! python3 -c 'import fontTools, brotli' 2>/dev/null; then
  echo 'Нужен fontTools с brotli — смотрите комментарий в начале файла.' >&2
  exit 1
fi

mkdir -p "$DST"
total_before=0
total_after=0

for src in "$SRC"/*.woff2; do
  name=$(basename "$src")
  before=$(stat -c%s "$src")
  python3 -m fontTools.subset "$src" \
    --unicodes="$RANGES" \
    --layout-features='*' \
    --flavor=woff2 \
    --with-zopfli \
    --output-file="$DST/$name" \
    --no-hinting --desubroutinize \
    --name-IDs='*' --name-legacy --name-languages='*' \
    >/dev/null
  after=$(stat -c%s "$DST/$name")
  total_before=$((total_before + before))
  total_after=$((total_after + after))
  printf '%-34s %6s КБ → %6s КБ\n' "$name" "$((before / 1024))" "$((after / 1024))"
done

echo
printf 'ИТОГО: %s КБ → %s КБ (осталось %s%%)\n' \
  "$((total_before / 1024))" "$((total_after / 1024))" \
  "$((total_after * 100 / total_before))"
