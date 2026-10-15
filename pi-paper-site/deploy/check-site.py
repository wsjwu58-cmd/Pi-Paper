"""Check the deployable static files without dependencies."""
from html.parser import HTMLParser
from pathlib import Path

root = Path(__file__).resolve().parents[1]

class Check(HTMLParser):
    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        for name in ['src', 'href', 'data-preview']:
            value = data.get(name, '')
            if value and not value.startswith(('http', '#')):
                assert (root / value).is_file(), f'Missing: {value}'
        if tag == 'a' and data.get('target') == '_blank':
            assert 'noopener' in data.get('rel', ''), data
        if tag == 'img':
            assert 'alt' in data, data

Check().feed((root / 'index.html').read_text(encoding='utf-8'))
print('HTML parsed; local assets, image alt text and external link attributes verified.')
