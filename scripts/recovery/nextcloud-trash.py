"""Parse only bounded user trash properties; restoration authority stays in JS."""
import json
import sys
import xml.etree.ElementTree as ET

D = '{DAV:}'
O = '{http://owncloud.org/ns}'
N = '{http://nextcloud.org/ns}'
FIELDS = {D+'resourcetype', D+'getetag', D+'getcontentlength', O+'fileid',
          N+'trashbin-filename', N+'trashbin-original-location', N+'trashbin-deletion-time'}
try:
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    text = raw.decode('utf-8')
    if len(raw) > 2 * 1024 * 1024 or '<!' in text or '\0' in text:
        raise ValueError()
    root = ET.fromstring(text)
    if root.tag != D+'multistatus' or not 1 <= len(root) <= 4097:
        raise ValueError()
    result = []
    for item in root:
        hrefs = item.findall(D+'href')
        if item.tag != D+'response' or len(hrefs) != 1 or len(hrefs[0]) or not hrefs[0].text:
            raise ValueError()
        values, seen = {}, set()
        for group in item:
            if group.tag == D+'href':
                continue
            props, status = group.findall(D+'prop'), group.findall(D+'status')
            if group.tag != D+'propstat' or len(group) != 2 or len(props) != 1 or len(status) != 1:
                raise ValueError()
            if status[0].text not in ('HTTP/1.1 200 OK', 'HTTP/1.1 404 Not Found'):
                raise ValueError()
            for prop in props[0]:
                if prop.tag not in FIELDS or prop.tag in seen:
                    raise ValueError()
                seen.add(prop.tag)
                if status[0].text == 'HTTP/1.1 200 OK':
                    values[prop.tag] = prop
        if D+'resourcetype' not in values or seen != FIELDS:
            raise ValueError()
        resource = values[D+'resourcetype']
        if len(resource) > 1 or (len(resource) == 1 and (resource[0].tag != D+'collection' or len(resource[0]))):
            raise ValueError()
        collection = len(resource) == 1
        if not collection and set(values) != FIELDS:
            raise ValueError()
        for key, value in values.items():
            if key != D+'resourcetype' and len(value):
                raise ValueError()
        def value(key):
            return (values[key].text or '') if key in values else None
        result.append({'href': hrefs[0].text, 'collection': collection,
                       'fileId': value(O+'fileid'), 'etag': value(D+'getetag'),
                       'size': value(D+'getcontentlength'), 'name': value(N+'trashbin-filename'),
                       'originalLocation': value(N+'trashbin-original-location'),
                       'deletionTime': value(N+'trashbin-deletion-time')})
    if len({item['href'] for item in result}) != len(result):
        raise ValueError()
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
except Exception:
    sys.stderr.write('Invalid backup trash metadata.\n')
    sys.exit(1)
