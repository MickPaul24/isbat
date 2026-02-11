const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { minify: minifyHtml } = require('html-minifier-terser');
const csso = require('csso');

const DIST_DIR = path.join(__dirname, '../dist');
const SRC_DIR = path.join(__dirname, '..');

// Ensure dist exists
if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR);

function getAllFiles(dirPath, arrayOfFiles) {
    const files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];
    files.forEach(function (file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
            if (file === 'node_modules' || file === 'dist' || file === '.git' || file === 'scripts') return;
            arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
        } else {
            arrayOfFiles.push(path.join(dirPath, "/", file));
        }
    });
    return arrayOfFiles;
}

// Helper to copy files
function copyDir(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    if (!fs.existsSync(src)) return;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// 1. Process Images
async function processImages() {
    console.log('Processing images...');
    const imgDest = path.join(DIST_DIR, 'img');
    fs.mkdirSync(imgDest, { recursive: true });

    // Find all images
    const allFiles = getAllFiles(path.join(SRC_DIR, 'img'));

    let sharp;
    try {
        sharp = require('sharp');
    } catch (e) {
        console.warn("Sharp not found, skipping optimization");
    }

    for (const srcPath of allFiles) {
        const relPath = path.relative(path.join(SRC_DIR), srcPath);
        // Ensure relative path doesn't start with /
        const destPath = path.join(DIST_DIR, relPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const ext = path.extname(srcPath).toLowerCase();

        if (sharp && ['.jpg', '.jpeg', '.png'].includes(ext)) {
            try {
                // Generate WebP
                const webpPath = destPath.replace(ext, '.webp');
                await sharp(srcPath)
                    .webp({ quality: 80 })
                    .toFile(webpPath);

                // Copy/Optimize Original
                if (ext === '.jpg' || ext === '.jpeg') {
                    await sharp(srcPath).jpeg({ mozjpeg: true, quality: 80 }).toFile(destPath);
                } else {
                    await sharp(srcPath).png({ quality: 80, compressionLevel: 8 }).toFile(destPath);
                }
            } catch (err) {
                console.error(`Error processing image ${srcPath}:`, err);
                fs.copyFileSync(srcPath, destPath);
            }
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// 2. Process CSS
async function processCSS() {
    console.log('Processing CSS...');
    const allFiles = getAllFiles(path.join(SRC_DIR, 'css'));
    for (const srcPath of allFiles) {
        if (!srcPath.endsWith('.css')) continue;
        const relPath = path.relative(SRC_DIR, srcPath);
        const destPath = path.join(DIST_DIR, relPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const content = fs.readFileSync(srcPath, 'utf8');
        try {
            const minified = csso.minify(content).css;
            fs.writeFileSync(destPath, minified);
        } catch (e) {
            console.error('CSS Minify error:', e);
            fs.writeFileSync(destPath, content);
        }
    }
}
// 3. Process JS
async function processJS() {
    console.log('Processing JS...');
    const allFiles = getAllFiles(path.join(SRC_DIR, 'js'));
    for (const srcPath of allFiles) {
        if (!srcPath.endsWith('.js')) continue;
        const relPath = path.relative(SRC_DIR, srcPath);
        const destPath = path.join(DIST_DIR, relPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        try {
            await esbuild.build({
                entryPoints: [srcPath],
                outfile: destPath,
                minify: true,
                sourcemap: false,
                target: ['es2015']
            });
        } catch (e) {
            console.error(`Error minifying ${srcPath}:`, e);
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// 4. Copy Static Assets
function copyStatic() {
    console.log('Copying static assets...');
    ['fonts', 'icons', 'models', 'mockups', 'manifest.json', 'robots.txt', 'sitemap.xml', 'service-worker.js', 'submision_sound.mp3'].forEach(f => {
        const src = path.join(SRC_DIR, f);
        const dest = path.join(DIST_DIR, f);
        if (fs.existsSync(src)) {
            if (fs.lstatSync(src).isDirectory()) {
                copyDir(src, dest);
            } else {
                fs.copyFileSync(src, dest);
            }
        }
    });
}

// 5. Process HTML
async function processHTML() {
    console.log('Processing HTML...');
    let html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');

    // Replacements
    html = html.replace(/<img([^>]*)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
        let newSrc = src;
        const ext = path.extname(src).toLowerCase();
        if (['.jpg', '.jpeg', '.png'].includes(ext)) {
            if (!src.startsWith('http') && !src.startsWith('//')) {
                newSrc = src.replace(ext, '.webp');
            }
        }

        let lazy = ' loading="lazy" decoding="async"';
        if (match.includes('avatar__image') || match.includes('jude.jpg')) {
            lazy = ' fetchpriority="high"';
        }

        // Preserve class, alt etc.
        // return <img${before}src="${newSrc}"${after}${lazy}>;
    });

    html = html.replace(/<script([^>]*)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
        if (src.includes('widget.js')) return match;
        if (before.includes('defer') || after.includes('defer')) return match;
        // return <script${before}src="${src}"${after} defer>;
    });

    try {
        const loaderCssPath = path.join(DIST_DIR, 'css/loaders/loader.css');
        if (fs.existsSync(loaderCssPath)) {
            const loaderCss = fs.readFileSync(loaderCssPath, 'utf8');
            html = html.replace(/<link rel="stylesheet" href="css\/loaders\/loader.css">/, `<style>${loaderCss}</style>`);
        }
    } catch (e) { }

    // Minify HTML
    const minified = await minifyHtml(html, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true,
        processScripts: ['application/ld+json']
    });

    fs.writeFileSync(path.join(DIST_DIR, 'index.html'), minified);
}

// 6. Security Headers Config (Netlify/Vercel)
function writeSecurityConfigs() {
    // Netlify _headers
    const headers = `/*
  X-Frame-Options: SAMEORIGIN
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(self), microphone=()
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://assets.calendly.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://assets.calendly.com; img-src 'self' data: https://assets.calendly.com; font-src 'self' https://cdnjs.cloudflare.com; connect-src 'self'; media-src 'self'; object-src 'none'; frame-src https://calendly.com;
`;
    fs.writeFileSync(path.join(DIST_DIR, '_headers'), headers);
    // Security.txt
    if (!fs.existsSync(path.join(DIST_DIR, '.well-known'))) fs.mkdirSync(path.join(DIST_DIR, '.well-known'));
    fs.writeFileSync(path.join(DIST_DIR, '.well-known/security.txt'), 'Contact: mailto:judextine28@gmail.com\nExpires: 2026-12-31T23:59:59z\n');
}

async function build() {
    try {
        await processImages();
        await processCSS();
        await processJS();
        copyStatic();
        await processHTML();
        writeSecurityConfigs();
        console.log('Build complete!');
    } catch (e) {
        console.error('Build failed:', e);
        process.exit(1);
    }
}

build();