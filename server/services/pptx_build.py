#!/usr/bin/env python3
"""
Собирает новую презентацию из списка (путь_к_исходному_pptx, индекс_слайда),
копируя слайды вместе с их оригинальным оформлением: slide layout, slide master,
тема (цвета/шрифты), фон и все связанные медиафайлы.

Вход: JSON-файл со списком {"items": [{"path": "...", "index": 0}, ...], "output": "..."}
передаётся как единственный аргумент — путь к этому JSON-файлу.

Почему не python-pptx "как есть": python-pptx не поддерживает копирование слайдов между
презентациями и тем более — копирование slide master/layout с сохранением их relationship-графа
(тема, медиа). Слайд, добавленный на layout презентации назначения по умолчанию, не имеет
доступа к оригинальному фону/теме/шрифтам исходного файла — оформление слетает.

Подход: работаем с .pptx как с ZIP/OOXML-пакетом напрямую.
Для каждого исходного файла, из которого берётся хотя бы один слайд, копируем целиком его
slideMaster, все его slideLayouts и тему (со всеми их relationship-зависимостями, включая
медиафайлы), затем копируем сами слайды, привязывая их к скопированным layout'ам.
Все части получают новые уникальные имена в результирующем пакете, чтобы избежать коллизий
между несколькими исходными презентациями.
"""
import sys
import json
import re
import zipfile
import posixpath
from xml.etree import ElementTree as ET

RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

RELTYPE_SLIDE_MASTER = f'{R_NS}/slideMaster'
RELTYPE_SLIDE_LAYOUT = f'{R_NS}/slideLayout'
RELTYPE_THEME = f'{R_NS}/theme'
RELTYPE_SLIDE = f'{R_NS}/slide'

CONTENT_TYPE_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.emf': 'image/x-emf', '.wmf': 'image/x-wmf', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.bin': 'application/vnd.openxmlformats-officedocument.presentationml.printerSettings',
}
OVERRIDE_CT_BY_PREFIX = [
    ('ppt/slideMasters/slideMaster', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'),
    ('ppt/slideLayouts/slideLayout', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'),
    ('ppt/theme/theme', 'application/vnd.openxmlformats-officedocument.theme+xml'),
    ('ppt/slides/slide', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'),
    # Точные имена вспомогательных частей, которые main() копирует из первого источника без изменений.
    # Раньше их Override приходил бесплатно из-за наследования всего шаблонного [Content_Types].xml;
    # теперь, когда Override строится только по фактическим частям, их нужно прописать явно.
    ('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),
    ('ppt/presProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'),
    ('ppt/viewProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'),
    ('ppt/tableStyles.xml', 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'),
    ('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'),
    ('docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'),
]

# Content-type для "прочих" частей (диаграммы и их зависимости), определяется по relationship
# type связи, через которую на часть ссылаются — не по расширению файла, т.к. и chart.xml,
# и chartColors.xml, и slide.xml имеют одно расширение .xml, но разные content-type.
OTHER_PART_CONTENT_TYPE_BY_RELTYPE = {
    f'{R_NS}/chart': 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
    f'{R_NS}/chartUserShapes': 'application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml',
    'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle': 'application/vnd.ms-office.chartcolorstyle+xml',
    'http://schemas.microsoft.com/office/2011/relationships/chartStyle': 'application/vnd.ms-office.chartstyle+xml',
    f'{R_NS}/oleObject': 'application/vnd.openxmlformats-officedocument.oleObject',
}

def qn(ns, tag):
    return f'{{{ns}}}{tag}'


def _xml_escape_attr(value):
    return (
        value.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
    )


class SourcePackage:
    """Чтение частей и relationships конкретного исходного .pptx файла."""

    def __init__(self, path):
        self.path = path
        self.zf = zipfile.ZipFile(path, 'r')
        self.names = set(self.zf.namelist())

    def read(self, name):
        return self.zf.read(name)

    def read_xml(self, name):
        return ET.fromstring(self.zf.read(name))

    @staticmethod
    def rels_path_for(part_name):
        d, f = posixpath.split(part_name)
        return posixpath.join(d, '_rels', f + '.rels')

    def get_rels(self, part_name):
        """-> list of dict(rid, reltype, target, is_external)"""
        rels_path = self.rels_path_for(part_name)
        if rels_path not in self.names:
            return []
        root = self.read_xml(rels_path)
        base_dir = posixpath.dirname(part_name)
        out = []
        for rel in root.findall(qn(RELS_NS, 'Relationship')):
            rid = rel.get('Id')
            reltype = rel.get('Type')
            target = rel.get('Target')
            is_external = rel.get('TargetMode') == 'External'
            abs_target = target if is_external else posixpath.normpath(posixpath.join(base_dir, target))
            out.append({'rid': rid, 'reltype': reltype, 'target': abs_target, 'is_external': is_external})
        return out


class OutputPackage:
    """Накопитель частей нового .pptx, с финальной сборкой ZIP на диск."""

    def __init__(self):
        self.parts = {}       # part_name -> bytes
        self.rels = {}        # part_name -> list of rel dicts
        self._counters = {'slideMaster': 0, 'slideLayout': 0, 'theme': 0, 'slide': 0, 'media': 0, 'other': 0}
        self.other_part_content_types = {}  # part_name -> content-type override (для 'other'-частей вроде chart.xml)

    def alloc_name(self, kind, ext):
        self._counters[kind] += 1
        folder = {
            'slideMaster': 'ppt/slideMasters', 'slideLayout': 'ppt/slideLayouts',
            'theme': 'ppt/theme', 'slide': 'ppt/slides', 'media': 'ppt/media', 'other': 'ppt/extra',
        }[kind]
        return f'{folder}/{kind}{self._counters[kind]}{ext}'

    def add_part(self, name, data):
        self.parts[name] = data

    def set_rels(self, part_name, rel_list):
        """rel_list: list of dict(rid, reltype, target, is_external) — target уже относительный путь для internal."""
        self.rels[part_name] = rel_list

    def note_other_part_content_type(self, part_name, reltype, ext):
        """Запоминает правильный content-type для 'other'-части по типу relationship, через который на
        неё ссылаются (chart, chartStyle, oleObject...). Если тип связи не требует Override (например embedded
        .xlsx покрывается Default по расширению), ничего не делает."""
        ctype = OTHER_PART_CONTENT_TYPE_BY_RELTYPE.get(reltype)
        if ctype:
            self.other_part_content_types[part_name] = ctype

    def rels_xml_bytes(self, rel_list):
        # Важно: корневой элемент должен быть в дефолтном namespace (xmlns="..."), а не с префиксом
        # (xmlns:ns0="...") — иначе LibreOffice/PowerPoint отказываются читать пакет.
        # ElementTree с register_namespace('', uri) глобально конфликтует между разными namespace,
        # поэтому собираем XML вручную строкой.
        parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n']
        parts.append(f'<Relationships xmlns="{RELS_NS}">')
        for rel in rel_list:
            attrs = f'Id="{_xml_escape_attr(rel["rid"])}" Type="{_xml_escape_attr(rel["reltype"])}" Target="{_xml_escape_attr(rel["target"])}"'
            if rel.get('is_external'):
                attrs += ' TargetMode="External"'
            parts.append(f'<Relationship {attrs}/>')
        parts.append('</Relationships>')
        return ''.join(parts).encode('utf-8')

    def save(self, output_path):
        for part_name, rel_list in self.rels.items():
            rels_path = SourcePackage.rels_path_for(part_name)
            self.parts[rels_path] = self.rels_xml_bytes(rel_list)

        # [Content_Types].xml должен физически идти первым в ZIP-архиве — некоторые реализации
        # (в том числе LibreOffice) отказываются открывать пакет, если это не так.
        ordered_names = ['[Content_Types].xml'] + [n for n in self.parts if n != '[Content_Types].xml']
        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as out:
            for name in ordered_names:
                out.writestr(name, self.parts[name])


def rel_target_path(new_part_name, referencing_part_name):
    """Возвращает Target-путь (относительный, POSIX, с ../ при необходимости) от referencing_part_name к new_part_name,
    как это принято в OOXML relationship-файлах (относительно директории части-источника связи)."""
    base_dir = posixpath.dirname(referencing_part_name)
    rel = posixpath.relpath(new_part_name, base_dir)
    return rel


def copy_media_part(out_pkg, src_pkg, target, referencing_new_part_name):
    ext = posixpath.splitext(target)[1]
    new_name = out_pkg.alloc_name('media', ext)
    out_pkg.add_part(new_name, src_pkg.read(target))
    return new_name


def import_other_part(out_pkg, src_pkg, target, reltype, cache):
    """
    Копирует произвольную вспомогательную часть пакета (диаграмма, встроенный Excel/OLE-объект,
    chart style/colors и т.п.) РЕКУРСИВНО вместе с её собственными relationships (например, chart.xml →
    embedded .xlsx с данными, или chart.xml → chartStyle/chartColors). Без этого chart-парт ссылается на
    несуществующий rId в итоговом пакете, и PowerPoint отказывается читать весь файл.
    cache: dict src_target -> new_name, чтобы одна и та же встроенная часть не клонировалась повторно, если на неё
    ссылается несколько частей (например chart и chartUserShapes на один и тот же embedding).
    Возвращает имя новой части.
    """
    cache_key = (id(src_pkg), target)  # id(src_pkg) — чтобы не путать одинаковые внутренние пути разных исходных файлов
    if cache_key in cache:
        return cache[cache_key]

    ext = posixpath.splitext(target)[1]
    new_name = out_pkg.alloc_name('other', ext)
    cache[cache_key] = new_name  # регистрируем заранее на случай циклических ссылок

    data = src_pkg.read(target)
    src_rels = src_pkg.get_rels(target)

    new_rels = []
    for rel in src_rels:
        if rel['is_external']:
            new_rels.append(dict(rel))
            continue
        rtype = rel['reltype']
        rtarget = rel['target']
        if rtarget.startswith('ppt/media/'):
            new_media_name = copy_media_part(out_pkg, src_pkg, rtarget, new_name)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_media_name, new_name), 'is_external': False})
        else:
            try:
                src_pkg.read(rtarget)
            except KeyError:
                continue
            nested_new_name = import_other_part(out_pkg, src_pkg, rtarget, rtype, cache)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(nested_new_name, new_name), 'is_external': False})

    out_pkg.add_part(new_name, data)
    out_pkg.set_rels(new_name, new_rels)
    out_pkg.note_other_part_content_type(new_name, reltype, ext)
    return new_name


def import_generic_part_with_rels(out_pkg, src_pkg, target, kind, referencing_context, other_cache):
    """
    Копирует произвольную XML-часть (например slideLayout) вместе со всеми её relationships,
    рекурсивно копируя зависимые части (тема, медиа). Не рекурсирует в slideMaster (для layout
    связь на master не нужна копировать — layout ссылается на master, но при рендере плейсхолдеров
    python-pptx на чтение это не обязательно; PowerPoint требует прямого rel, но мы для layout
    сохраняем ЕГО связь на master ниже отдельно, если она есть в исходных rels).
    Возвращает имя новой части.
    """
    data = src_pkg.read(target)
    new_name = out_pkg.alloc_name(kind, posixpath.splitext(target)[1])
    src_rels = src_pkg.get_rels(target)

    new_rels = []
    rid_map = {}
    for rel in src_rels:
        if rel['is_external']:
            new_rels.append(dict(rel))
            continue
        rtype = rel['reltype']
        rtarget = rel['target']
        if rtype == RELTYPE_THEME:
            new_theme_name = import_generic_part_with_rels(out_pkg, src_pkg, rtarget, 'theme', referencing_context)
            new_rid = rel['rid']
            rid_map[rel['rid']] = new_rid
            new_rels.append({'rid': new_rid, 'reltype': rtype, 'target': rel_target_path(new_theme_name, new_name), 'is_external': False})
        elif rtype == RELTYPE_SLIDE_MASTER:
            # slideLayout -> slideMaster back-reference: подставим позже через referencing_context
            new_rid = rel['rid']
            rid_map[rel['rid']] = new_rid
            master_new_name = referencing_context.get('master_new_name')
            if master_new_name:
                new_rels.append({'rid': new_rid, 'reltype': rtype, 'target': rel_target_path(master_new_name, new_name), 'is_external': False})
        elif rtarget.startswith('ppt/media/'):
            new_media_name = copy_media_part(out_pkg, src_pkg, rtarget, new_name)
            new_rid = rel['rid']
            rid_map[rel['rid']] = new_rid
            new_rels.append({'rid': new_rid, 'reltype': rtype, 'target': rel_target_path(new_media_name, new_name), 'is_external': False})
        else:
            # Прочие вложенные части (диаграммы и их зависимости, встречаются в т.ч. на layout/master
            # уровне) — копируем РЕКУРСИВНО вместе с их собственными relationships.
            try:
                src_pkg.read(rtarget)
            except KeyError:
                continue
            new_other_name = import_other_part(out_pkg, src_pkg, rtarget, rtype, other_cache)
            new_rid = rel['rid']
            rid_map[rel['rid']] = new_rid
            new_rels.append({'rid': new_rid, 'reltype': rtype, 'target': rel_target_path(new_other_name, new_name), 'is_external': False})

    out_pkg.add_part(new_name, data)  # rId'ы в самом XML не меняются, т.к. мы сохраняем те же Id в новых rels
    out_pkg.set_rels(new_name, new_rels)
    return new_name


def import_slide_master(out_pkg, src_pkg, master_target, cache, other_cache):
    if master_target in cache:
        return cache[master_target]

    new_master_name = out_pkg.alloc_name('slideMaster', '.xml')
    cache[master_target] = new_master_name  # регистрируем заранее на случай циклических ссылок

    data = src_pkg.read(master_target)
    src_rels = src_pkg.get_rels(master_target)

    new_rels = []
    layout_map = {}  # старый target slideLayout -> новое имя
    for rel in src_rels:
        if rel['is_external']:
            new_rels.append(dict(rel))
            continue
        rtype = rel['reltype']
        rtarget = rel['target']
        if rtype == RELTYPE_SLIDE_LAYOUT:
            new_layout_name = import_generic_part_with_rels(
                out_pkg, src_pkg, rtarget, 'slideLayout', {'master_new_name': new_master_name}, other_cache
            )
            layout_map[rtarget] = new_layout_name
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_layout_name, new_master_name), 'is_external': False})
        elif rtype == RELTYPE_THEME:
            new_theme_name = import_generic_part_with_rels(out_pkg, src_pkg, rtarget, 'theme', {}, other_cache)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_theme_name, new_master_name), 'is_external': False})
        elif rtarget.startswith('ppt/media/'):
            new_media_name = copy_media_part(out_pkg, src_pkg, rtarget, new_master_name)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_media_name, new_master_name), 'is_external': False})
        else:
            try:
                src_pkg.read(rtarget)
            except KeyError:
                continue
            new_other_name = import_other_part(out_pkg, src_pkg, rtarget, rtype, other_cache)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_other_name, new_master_name), 'is_external': False})

    out_pkg.add_part(new_master_name, data)
    out_pkg.set_rels(new_master_name, new_rels)

    return {'new_master_name': new_master_name, 'layout_map': layout_map}


def import_slide(out_pkg, src_pkg, slide_target, new_layout_name, other_cache):
    new_slide_name = out_pkg.alloc_name('slide', '.xml')
    data = src_pkg.read(slide_target)
    src_rels = src_pkg.get_rels(slide_target)

    new_rels = []
    for rel in src_rels:
        if rel['is_external']:
            new_rels.append(dict(rel))
            continue
        rtype = rel['reltype']
        rtarget = rel['target']
        if rtype == RELTYPE_SLIDE_LAYOUT:
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_layout_name, new_slide_name), 'is_external': False})
        elif rtarget.startswith('ppt/media/'):
            new_media_name = copy_media_part(out_pkg, src_pkg, rtarget, new_slide_name)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_media_name, new_slide_name), 'is_external': False})
        else:
            try:
                src_pkg.read(rtarget)
            except KeyError:
                continue
            new_other_name = import_other_part(out_pkg, src_pkg, rtarget, rtype, other_cache)
            new_rels.append({'rid': rel['rid'], 'reltype': rtype, 'target': rel_target_path(new_other_name, new_slide_name), 'is_external': False})

    out_pkg.add_part(new_slide_name, data)
    out_pkg.set_rels(new_slide_name, new_rels)
    return new_slide_name


def get_slide_master_target_for_layout(src_pkg, slide_target):
    """Находит slideLayout part-path, на который ссылается конкретный слайд (slideN.xml)."""
    rels = src_pkg.get_rels(slide_target)
    for rel in rels:
        if rel['reltype'] == RELTYPE_SLIDE_LAYOUT:
            return rel['target']
    return None


def get_master_for_layout(src_pkg, layout_target):
    rels = src_pkg.get_rels(layout_target)
    for rel in rels:
        if rel['reltype'] == RELTYPE_SLIDE_MASTER:
            return rel['target']
    return None


def get_slide_size(src_pkg):
    root = src_pkg.read_xml('ppt/presentation.xml')
    sz = root.find(qn(P_NS, 'sldSz'))
    if sz is not None:
        return sz.get('cx'), sz.get('cy')
    return '9144000', '6858000'


def build_content_types(out_pkg, template_ct_bytes_by_source):
    """
    template_ct_bytes_by_source: список [Content_Types].xml всех исходных файлов, из которых брались слайды.
    ВАЖНО: мы НЕ копируем Override-записи шаблонно из шаблона (раньше так было сделано из-за
    чего в выводе оставались "мёртвые" Override для слайдов/диаграмм, которые в итоговую сборку
    не вошли). Вместо этого Override строим строго по фактически присутствующим в выводе частям
    (out_pkg.parts), а Default-записи (по расширению) безопасно объединяем из всех исходников (Default не
    привязан к конкретному файлу, лишние записи безвредны).
    """
    # Собираем Default-записи со всех шаблонов — безопасно и покрывает нестандартные расширения.
    existing_defaults = {}  # extension -> content_type
    for ct_bytes in template_ct_bytes_by_source:
        ct_root = ET.fromstring(ct_bytes)
        for el in ct_root.findall(qn(CT_NS, 'Default')):
            ext = el.get('Extension')
            if ext not in existing_defaults:
                existing_defaults[ext] = el.get('ContentType')

    existing_overrides = set()  # пусто — Override строим только из фактических частей вывода

    extra_defaults = []  # (extension, content_type)
    extra_overrides = []  # (partname, content_type)

    if 'xml' not in existing_defaults:
        extra_defaults.append(('xml', 'application/xml'))
        existing_defaults['xml'] = 'application/xml'
    if 'rels' not in existing_defaults:
        extra_defaults.append(('rels', 'application/vnd.openxmlformats-package.relationships+xml'))
        existing_defaults['rels'] = 'application/vnd.openxmlformats-package.relationships+xml'

    for name in out_pkg.parts:
        pn = '/' + name
        if pn in existing_overrides:
            continue
        if name.startswith('ppt/extra/'):
            # "Прочие" части (диаграммы, встроенные объекты) — content-type определён заранее по
            # типу relationship (см. import_other_part/note_other_part_content_type). Если для неё есть
            # зарегистрированный Override (chart и т.п.) — используем его; иначе падаем на
            # Default по расширению (например embedded .xlsx, который в настоящих .pptx тоже
            # покрывается Default, а не Override).
            explicit_ctype = out_pkg.other_part_content_types.get(name)
            if explicit_ctype:
                extra_overrides.append((pn, explicit_ctype))
                existing_overrides.add(pn)
            else:
                ext = posixpath.splitext(name)[1].lstrip('.').lower()
                if ext and ext not in existing_defaults and ext in {e.lstrip('.') for e in CONTENT_TYPE_BY_EXT}:
                    extra_defaults.append((ext, CONTENT_TYPE_BY_EXT['.' + ext]))
                    existing_defaults[ext] = CONTENT_TYPE_BY_EXT['.' + ext]
        elif name.endswith('.xml'):
            for prefix, ctype in OVERRIDE_CT_BY_PREFIX:
                if name.startswith(prefix):
                    extra_overrides.append((pn, ctype))
                    existing_overrides.add(pn)
                    break
        elif name.startswith('ppt/media/'):
            ext = posixpath.splitext(name)[1].lstrip('.').lower()
            if ext and ext not in existing_defaults and ext in {e.lstrip('.') for e in CONTENT_TYPE_BY_EXT}:
                extra_defaults.append((ext, CONTENT_TYPE_BY_EXT['.' + ext]))
                existing_defaults[ext] = CONTENT_TYPE_BY_EXT['.' + ext]

    # Сериализуем весь список заново вручную, чтобы гарантированно получить дефолтный namespace везде.
    # all_defaults идёт из объединённого словаря шаблонов + новых записей (все уже объединены в
    # existing_defaults выше по ключу ext, так что просто берём весь словарь целиком, без дубликатов).
    all_defaults = list(existing_defaults.items())
    all_overrides = list(extra_overrides)

    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n']
    parts.append(f'<Types xmlns="{CT_NS}">')
    for ext, ctype in all_defaults:
        parts.append(f'<Default Extension="{_xml_escape_attr(ext)}" ContentType="{_xml_escape_attr(ctype)}"/>')
    for pn, ctype in all_overrides:
        parts.append(f'<Override PartName="{_xml_escape_attr(pn)}" ContentType="{_xml_escape_attr(ctype)}"/>')
    parts.append('</Types>')
    return ''.join(parts).encode('utf-8')


def main():
    config_path = sys.argv[1]
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    items = config['items']
    output_path = config['output']

    if not items:
        raise ValueError('Не переданы слайды для сборки')

    src_pkgs = {}
    for item in items:
        if item['path'] not in src_pkgs:
            src_pkgs[item['path']] = SourcePackage(item['path'])

    first_pkg = src_pkgs[items[0]['path']]
    cx, cy = get_slide_size(first_pkg)

    out_pkg = OutputPackage()

    # docProps/app.xml, core.xml — копируем из первого источника как базовые метаданные документа
    for name in ('docProps/core.xml', 'docProps/app.xml', 'ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml'):
        if name in first_pkg.names:
            out_pkg.add_part(name, first_pkg.read(name))

    out_pkg.add_part('_rels/.rels', (
        b"<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\r\n"
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        b'</Relationships>'
    ))

    # Собираем presentation.xml вручную строкой (см. пояснение в build_content_types выше) —
    # накапливаем списки записей sldMasterId/sldId, а XML собираем в конце.
    master_id_entries = []  # list of (id, rid)
    slide_id_entries = []   # list of (id, rid)

    pres_rels = []
    pres_rid_counter = 1
    master_cache_by_source = {}   # src_path -> {layout_target: new_layout_name}, master_target -> new_master_name
    master_target_new_name = {}   # (src_path, master_target) -> new_master_name
    master_id = 2147483648
    slide_id = 256

    added_masters = set()
    other_cache = {}  # src_target -> new_name — общий кэш для "прочих" частей (диаграммы и т.п.) на весь запуск

    for item in items:
        src_path = item['path']
        idx = item['index']
        src_pkg = src_pkgs[src_path]

        slide_target = f'ppt/slides/slide{idx + 1}.xml'
        if slide_target not in src_pkg.names:
            # запасной путь: найти slide-часть через presentation.xml.rels + sldIdLst по порядку
            pres_rels_src = src_pkg.get_rels('ppt/presentation.xml')
            pres_root_src = src_pkg.read_xml('ppt/presentation.xml')
            sldIdLst_src = pres_root_src.find(qn(P_NS, 'sldIdLst'))
            rid_by_pos = [el.get(qn(R_NS, 'id')) for el in sldIdLst_src.findall(qn(P_NS, 'sldId'))]
            target_rid = rid_by_pos[idx]
            slide_target = next(r['target'] for r in pres_rels_src if r['rid'] == target_rid)

        layout_target = get_slide_master_target_for_layout(src_pkg, slide_target)
        master_target = get_master_for_layout(src_pkg, layout_target) if layout_target else None

        cache_key = (src_path, master_target)
        if master_target and cache_key not in master_target_new_name:
            result = import_slide_master(out_pkg, src_pkg, master_target, {}, other_cache)
            master_target_new_name[cache_key] = result
            added_masters.add(cache_key)

            new_master_name = result['new_master_name']
            new_rid = f'rId{pres_rid_counter}'
            pres_rid_counter += 1
            pres_rels.append({'rid': new_rid, 'reltype': RELTYPE_SLIDE_MASTER, 'target': rel_target_path(new_master_name, 'ppt/presentation.xml'), 'is_external': False})
            master_id_entries.append((master_id, new_rid))
            master_id += 1

        layout_map = master_target_new_name[cache_key]['layout_map'] if master_target else {}
        new_layout_name = layout_map.get(layout_target)
        if new_layout_name is None:
            # слайд без обычного master/layout (крайне редко) — пропускаем связывание с layout
            raise ValueError(f'Не удалось определить layout для слайда {idx} файла {src_path}')

        new_slide_name = import_slide(out_pkg, src_pkg, slide_target, new_layout_name, other_cache)

        new_rid = f'rId{pres_rid_counter}'
        pres_rid_counter += 1
        pres_rels.append({'rid': new_rid, 'reltype': RELTYPE_SLIDE, 'target': rel_target_path(new_slide_name, 'ppt/presentation.xml'), 'is_external': False})
        slide_id_entries.append((slide_id, new_rid))
        slide_id += 1

    pres_xml_parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n']
    pres_xml_parts.append(
        f'<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        f'xmlns:r="{R_NS}" xmlns:p="{P_NS}">'
    )
    pres_xml_parts.append('<p:sldMasterIdLst>')
    for mid, rid in master_id_entries:
        pres_xml_parts.append(f'<p:sldMasterId id="{mid}" r:id="{rid}"/>')
    pres_xml_parts.append('</p:sldMasterIdLst>')
    pres_xml_parts.append('<p:sldIdLst>')
    for sid, rid in slide_id_entries:
        pres_xml_parts.append(f'<p:sldId id="{sid}" r:id="{rid}"/>')
    pres_xml_parts.append('</p:sldIdLst>')
    pres_xml_parts.append(f'<p:sldSz cx="{cx}" cy="{cy}"/>')
    pres_xml_parts.append('<p:notesSz cx="6858000" cy="9144000"/>')
    pres_xml_parts.append('</p:presentation>')

    out_pkg.add_part('ppt/presentation.xml', ''.join(pres_xml_parts).encode('utf-8'))
    out_pkg.set_rels('ppt/presentation.xml', pres_rels)

    ct_bytes_by_source = [pkg.read('[Content_Types].xml') for pkg in src_pkgs.values()]
    out_pkg.parts['[Content_Types].xml'] = build_content_types(out_pkg, ct_bytes_by_source)

    out_pkg.save(output_path)
    print(json.dumps({'ok': True, 'output': output_path, 'slide_count': len(items)}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({'error': str(e), 'trace': traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)
