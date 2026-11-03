"""Parse only the bounded, depth-zero WebDAV response used by ECO backup.

No credentials, network access, external entities or arbitrary output fields.
Run with the system Python's isolated mode.
"""
import json
import sys
import xml.etree.ElementTree as ET

DAV = '{DAV:}'
OC = '{http://owncloud.org/ns}'
NC = '{http://nextcloud.org/ns}'


def parse(raw):
    text = raw.decode('utf-8')
    if len(raw) > 65536 or '<!' in text or '\0' in text:
        raise ValueError()
    root = ET.fromstring(text)
    if root.tag != DAV + 'multistatus' or len(root) != 1:
        raise ValueError()
    response = root[0]
    if response.tag != DAV + 'response':
        raise ValueError()
    hrefs = response.findall(DAV + 'href')
    if len(hrefs) != 1 or len(hrefs[0]) or not hrefs[0].text:
        raise ValueError()
    values = {}
    for group in response:
        if group.tag == DAV + 'href':
            continue
        if group.tag != DAV + 'propstat':
            raise ValueError()
        status = group.findall(DAV + 'status')
        props = group.findall(DAV + 'prop')
        if len(status) != 1 or len(props) != 1 or len(group) != 2:
            raise ValueError()
        if status[0].text != 'HTTP/1.1 200 OK':
            raise ValueError()
        for prop in props[0]:
            if prop.tag in values:
                raise ValueError()
            values[prop.tag] = prop
    if set(values) != {DAV + 'resourcetype', OC + 'owner-id', NC + 'mount-type', NC + 'is-mount-root', OC + 'share-types'}:
        raise ValueError()
    resource = values[DAV + 'resourcetype']
    if len(resource) > 1 or (len(resource) == 1 and (resource[0].tag != DAV + 'collection' or len(resource[0]))):
        raise ValueError()
    for key in (OC + 'owner-id', NC + 'mount-type', NC + 'is-mount-root', OC + 'share-types'):
        if len(values[key]):
            raise ValueError()
    return {'href': hrefs[0].text, 'ownerId': values[OC + 'owner-id'].text or '',
            'mountType': values[NC + 'mount-type'].text or '',
            'isMountRoot': values[NC + 'is-mount-root'].text or '',
            'shareTypes': values[OC + 'share-types'].text or '', 'collection': len(resource) == 1}


try:
    result = parse(sys.stdin.buffer.read(65537))
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
except Exception:
    sys.stderr.write('Invalid backup folder metadata.\n')
    sys.exit(1)
