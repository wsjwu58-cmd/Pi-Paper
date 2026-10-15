"""Package only public files; deployment helpers never enter the web root."""
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root.parent / 'output' / 'pi-paper-site'
output.mkdir(parents=True, exist_ok=True)
public = output / 'public'
public.mkdir(exist_ok=True)
for name in ['index.html', 'styles.css', 'script.js', 'robots.txt', 'sitemap.xml']:
    shutil.copy2(root / name, public / name)
(public / 'assets').mkdir(exist_ok=True)
for name in ['canvas-workflow.webp', 'image-editor.webp', 'provider-configuration.webp', 'xiaop-paper.webp', 'icon.png']:
    shutil.copy2(root / 'assets' / name, public / 'assets' / name)
with zipfile.ZipFile(output / 'pi-paper-site.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in public.rglob('*'):
        if file.is_file():
            archive.write(file, file.relative_to(public))
print(f'Public directory: {public}')
print(f'Archive: {output / "pi-paper-site.zip"}')
