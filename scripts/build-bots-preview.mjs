import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function bundlePreview(target = resolve(root, 'build/bots-preview.html')) {
    const files = ['web/src/bots/model.mjs', 'web/src/bots/dom.mjs', 'web/src/bots/avatar.mjs', 'web/src/bots/workspace.mjs', 'web/test/bots/preview-adapter.mjs', 'web/test/bots/preview-entry.mjs'];
    const modules = new Map();
    let js = '(()=>{\nconst __m=[];\n';
    for (const [index, file] of files.entries()) {
        const absolute = resolve(root, file);
        let source = readFileSync(absolute, 'utf8');
        const exports = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map(m => m[1]);
        source = source.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (_, names, dependency) => {
            const dep = modules.get(resolve(dirname(absolute), dependency));
            if (dep === undefined)
                throw new Error(`Missing dependency ${dependency}`);
            return `const {${names}}=__m[${dep}];`;
        }).replace(/^export /gm, '');
        js += `__m[${index}]=(()=>{\n${source}\nreturn {${exports.join(',')}};\n})();\n`;
        modules.set(absolute, index);
    }
    js += '})();';
    const css = readFileSync(resolve(root, 'web/src/bots/bots.css'), 'utf8');
    const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>e-launcher · Bots 交互预览</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}${css.replaceAll('</style', '<\\/style')}</style></head><body><div id="bots-root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    console.log(bundlePreview(process.argv[2] ? resolve(process.argv[2]) : undefined));
