# Лицензии шрифтов

Все файлы в этом каталоге распространяются вместе с сайтом, поэтому их лицензии
приложены здесь — этого требуют и SIL OFL, и GPL. Данные взяты из самих файлов
(поля `copyright`, `license`, `licenseURL` таблицы `name`).

| Семейство | Правообладатель | Лицензия |
| --- | --- | --- |
| **Lato** | tyPoland Lukasz Dziedzic, 2010–2014 | SIL Open Font License 1.1 — <http://scripts.sil.org/OFL> |
| **Inter** | The Inter Project Authors, 2016 | SIL Open Font License 1.1 — <https://openfontlicense.org> |
| **Roboto** | Google Inc., 2011 | Apache License 2.0 — <http://www.apache.org/licenses/LICENSE-2.0> |
| **Source Code Pro** | Adobe, 2023 | SIL Open Font License 1.1 — <http://scripts.sil.org/OFL> |
| **Liberation Sans**, **Liberation Serif** | Ascender Corporation, 2007 (версии 1.04 и 1.05) | GPLv2 с шрифтовым исключением |

## Про Liberation

В каталоге лежат версии **1.04 и 1.05** — это ещё до перевода семейства на SIL OFL,
который произошёл в версии 2.00 (2012). Версии 1.x выпущены под GPLv2 со шрифтовым
исключением: распространять их можно, встраивание шрифта в документ не распространяет
GPL на сам документ. Если однажды захочется избавиться от GPL в проекте — достаточно
заменить файлы на Liberation 2.x под OFL.

## Что было изъято

Из проекта убраны **Whitney** (Hoefler & Frere-Jones, проприетарная EULA) и
**Antiqua** (Atech Software, 1991 — поля лицензии в файле нет вовсе). Показать
разрешение на их распространение нечем. Файлы перенесены в `fonts-removed/`
и приложением не используются.

## Про урезание

Файлы здесь — сокращённые: оставлены только нужные проекту диапазоны символов.
Полные исходники лежат в `fonts-original/`, пересборка — `tools/subset-fonts.sh`.
Урезание не меняет лицензионных условий: производные работы OFL и GPL разрешают,
имена семейств не менялись.
