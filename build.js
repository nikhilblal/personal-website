import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { Eta } from 'eta';
import chokidar from 'chokidar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Setup markdown-it with video embed support
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
});

// Custom renderer for video embeds
const defaultImageRender = md.renderer.rules.image || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const src = token.attrGet('src');
  const alt = token.content;

  // YouTube embed
  if (src.includes('youtube.com/watch?v=') || src.includes('youtu.be/')) {
    const videoId = src.includes('youtu.be/')
      ? src.split('youtu.be/')[1].split('?')[0]
      : src.split('v=')[1].split('&')[0];

    return `<div class="video-embed">
      <iframe
        src="https://www.youtube.com/embed/${videoId}"
        frameborder="0"
        allowfullscreen
        title="${alt}">
      </iframe>
    </div>`;
  }

  // Vimeo embed
  if (src.includes('vimeo.com/')) {
    const videoId = src.split('vimeo.com/')[1].split('?')[0];
    return `<div class="video-embed">
      <iframe
        src="https://player.vimeo.com/video/${videoId}"
        frameborder="0"
        allowfullscreen
        title="${alt}">
      </iframe>
    </div>`;
  }

  // Default image rendering
  return defaultImageRender(tokens, idx, options, env, self);
};

// Handle YouTube shortcode syntax: `youtube: VIDEO_ID`
function processYouTubeShortcodes(content) {
  return content.replace(/`youtube:\s*([a-zA-Z0-9_-]+)`/g, (match, videoId) => {
    return `<div class="video-embed">
      <iframe
        src="https://www.youtube.com/embed/${videoId}"
        frameborder="0"
        allowfullscreen>
      </iframe>
    </div>`;
  });
}

// Setup Eta templating
const eta = new Eta({
  views: path.join(__dirname, 'templates'),
  cache: false
});

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function copyAssets() {
  const srcDir = path.join(__dirname, 'src');
  const distDir = path.join(__dirname, 'dist');

  try {
    const files = await fs.readdir(srcDir);
    for (const file of files) {
      const srcPath = path.join(srcDir, file);
      const distPath = path.join(distDir, file);

      const stat = await fs.stat(srcPath);
      if (stat.isFile()) {
        await fs.copyFile(srcPath, distPath);
      } else if (stat.isDirectory() && file === 'assets') {
        // Copy all assets recursively
        await copyDirectory(srcPath, path.join(distDir, 'assets'));
      }
    }
  } catch (err) {
    // src directory might not exist yet
  }
}

async function copyDirectory(src, dest) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      // Skip large video files to reduce build size
      const ext = path.extname(entry.name).toLowerCase();
      if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) {
        console.log(`Skipping large video file: ${srcPath}`);
        return;
      }
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function processMarkdownFile(filePath, contentDir, distDir) {
  const content = await fs.readFile(filePath, 'utf8');
  const { data: frontmatter, content: markdown } = matter(content);

  // Process YouTube shortcodes before markdown rendering
  const processedMarkdown = processYouTubeShortcodes(markdown);
  const html = md.render(processedMarkdown);

  // Generate output path
  const relativePath = path.relative(contentDir, filePath);
  const parsedPath = path.parse(relativePath);

  let outputPath;
  if (parsedPath.name === 'index') {
    outputPath = path.join(distDir, parsedPath.dir, 'index.html');
  } else {
    outputPath = path.join(distDir, parsedPath.dir, parsedPath.name, 'index.html');
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  await ensureDir(outputDir);

  // Copy assets from the same directory as the markdown file
  const markdownDir = path.dirname(filePath);
  const files = await fs.readdir(markdownDir);

  for (const file of files) {
    if (file !== 'index.md') {
      const srcAsset = path.join(markdownDir, file);
      const destAsset = path.join(outputDir, file);

      try {
        const stat = await fs.stat(srcAsset);
        if (stat.isFile()) {
          // Skip large video files to reduce build size
          const ext = path.extname(file).toLowerCase();
          if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) {
            console.log(`Skipping large video file: ${srcAsset}`);
            continue;
          }
          await fs.copyFile(srcAsset, destAsset);
        }
      } catch (err) {
        // File might not exist or be inaccessible
      }
    }
  }

  // Render with template
  const pageData = {
    title: frontmatter.title || 'Untitled',
    content: html,
    ...frontmatter
  };

  const template = frontmatter.template || 'page';
  const renderedHtml = await eta.render(template, pageData);

  await fs.writeFile(outputPath, renderedHtml);
  console.log(`Generated: ${outputPath}`);
}

async function collectProjectImages() {
  const contentDir = path.join(__dirname, 'content');
  const projects = [];

  // Scan all project directories
  const projectsDir = path.join(contentDir, 'projects');
  const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (dir.isDirectory()) {
      const projectPath = path.join(projectsDir, dir.name, 'index.md');

      try {
        const content = await fs.readFile(projectPath, 'utf8');
        const { data: frontmatter, content: markdown } = matter(content);

        // Extract images from markdown
        const imageRegex = /!\[.*?\]\((.*?)\)/g;
        const images = [];
        let match;

        while ((match = imageRegex.exec(markdown)) !== null) {
          let imagePath = match[1];
          // Convert relative paths to absolute asset paths
          if (imagePath.startsWith('./')) {
            imagePath = `/assets/${dir.name}/${imagePath.slice(2)}`;
          } else if (!imagePath.startsWith('http')) {
            imagePath = `/assets/${dir.name}/${imagePath}`;
          }
          images.push(imagePath);
        }

        if (images.length > 0) {
          projects.push({
            name: dir.name,
            title: frontmatter.title || dir.name,
            images: images,
            url: `/projects/${dir.name}/`
          });
        }
      } catch (err) {
        // Skip if no index.md or other error
      }
    }
  }

  return projects;
}

async function generateImageGridIndex(projects) {
  const distDir = path.join(__dirname, 'dist');

  // Create minimal HTML with just image grid
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Portfolio</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    .grid img, .grid video { width: 100%; height: 200px; object-fit: cover; display: block; }
    .grid a { display: block; }

    .floating-window {
      position: fixed;
      width: 300px;
      height: 220px;
      background: #c0c0c0;
      border-top: 3px solid #ffffff;
      border-left: 3px solid #ffffff;
      border-right: 3px solid #808080;
      border-bottom: 3px solid #808080;
      font-family: 'MS Sans Serif', monospace;
      font-size: 11px;
      z-index: 1000;
    }

    .window-header {
      background: linear-gradient(90deg, #0a246a 0%, #a6caf0 100%);
      color: white;
      padding: 2px 4px;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: 18px;
      cursor: move;
    }

    .window-title {
      font-size: 11px;
      font-family: 'MS Sans Serif', monospace;
    }

    .window-controls {
      display: flex;
      gap: 2px;
    }

    .window-button {
      width: 16px;
      height: 14px;
      background: #c0c0c0;
      border-top: 1px solid #ffffff;
      border-left: 1px solid #ffffff;
      border-right: 1px solid #808080;
      border-bottom: 1px solid #808080;
      font-size: 9px;
      line-height: 12px;
      text-align: center;
      cursor: pointer;
    }

    .window-button:active {
      border-top: 1px solid #808080;
      border-left: 1px solid #808080;
      border-right: 1px solid #ffffff;
      border-bottom: 1px solid #ffffff;
    }

    .window-content {
      padding: 8px;
      height: calc(100% - 18px);
      background: #c0c0c0;
      display: flex;
      flex-direction: column;
    }

    .dialog-section {
      display: flex;
      align-items: flex-start;
      margin-bottom: 8px;
      gap: 8px;
    }

    .exclamation-icon {
      width: 32px;
      height: 32px;
      background-image: url('https://64.media.tumblr.com/016da1fe17e4448ffe5dec8245bc6de2/a56aedd6feaabeea-69/s540x810/0396db374112ada8381638997a7b4ace003c9476.png');
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
      flex-shrink: 0;
    }

    .dialog-text {
      font-size: 11px;
      line-height: 1.4;
      color: #000000;
      font-family: 'MS Sans Serif', monospace;
    }

    .button-section {
      margin-top: auto;
      padding-bottom: 12px;
    }

    .button-group {
      margin-bottom: 8px;
    }

    .button-group:last-child {
      margin-bottom: 8px;
    }

    .button-group-label {
      font-size: 10px;
      font-weight: bold;
      margin-bottom: 4px;
      color: #000000;
      font-family: 'MS Sans Serif', monospace;
    }

    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .nav-button {
      display: inline-block;
      width: auto;
      min-width: 60px;
      padding: 2px 8px;
      background: #c0c0c0;
      border-top: 2px solid #ffffff;
      border-left: 2px solid #ffffff;
      border-right: 2px solid #808080;
      border-bottom: 2px solid #808080;
      text-decoration: none;
      color: black;
      font-size: 10px;
      font-family: 'MS Sans Serif', monospace;
      text-align: center;
    }

    .nav-button .shortcut {
      text-decoration: underline;
    }

    .nav-button:hover {
      background: #e0e0e0;
    }

    .nav-button:active {
      border-top: 2px solid #808080;
      border-left: 2px solid #808080;
      border-right: 2px solid #ffffff;
      border-bottom: 2px solid #ffffff;
      background: #c0c0c0;
    }
  </style>
  <script>
    function playDing() {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.2);
    }

    function playButtonClick() {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Short "doot" sound - higher pitch, very brief
      oscillator.frequency.setValueAtTime(1200, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.05);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.05);
    }

    let windowX = 50;
    let windowY = 50;
    let velocityX = 1.6;
    let velocityY = 1.2;
    let isPaused = false;

    function bounceWindow() {
      const floatingWindow = document.querySelector('.floating-window');
      if (!floatingWindow || isPaused) {
        requestAnimationFrame(bounceWindow);
        return;
      }

      const windowWidth = 300;
      const windowHeight = 220;
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;

      windowX += velocityX;
      windowY += velocityY;

      if (windowX <= 0 || windowX >= screenWidth - windowWidth) {
        velocityX = -velocityX;
      }
      if (windowY <= 0 || windowY >= screenHeight - windowHeight) {
        velocityY = -velocityY;
      }

      windowX = Math.max(0, Math.min(windowX, screenWidth - windowWidth));
      windowY = Math.max(0, Math.min(windowY, screenHeight - windowHeight));

      floatingWindow.style.left = windowX + 'px';
      floatingWindow.style.top = windowY + 'px';

      requestAnimationFrame(bounceWindow);
    }

    document.addEventListener('DOMContentLoaded', function() {
      const images = document.querySelectorAll('.grid img');
      images.forEach(img => {
        img.addEventListener('mouseenter', playDing);
      });

      // Start bouncing animation
      bounceWindow();

      // Pause animation on hover
      const floatingWindow = document.querySelector('.floating-window');
      if (floatingWindow) {
        floatingWindow.addEventListener('mouseenter', function() {
          isPaused = true;
        });

        floatingWindow.addEventListener('mouseleave', function() {
          isPaused = false;
        });
      }

      // Add click sound to all navigation buttons
      const navButtons = document.querySelectorAll('.nav-button');
      navButtons.forEach(button => {
        button.addEventListener('click', playButtonClick);
      });

      // Add keyboard shortcuts (direct key presses)
      document.addEventListener('keydown', function(e) {
        // Only trigger if not typing in an input field or textarea, and not holding modifier keys
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
            e.target.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) {
          return;
        }

        switch(e.key.toLowerCase()) {
          case 'a':
            e.preventDefault();
            e.stopPropagation();
            playButtonClick();
            window.location.href = '/about/';
            break;
          case 'r':
            e.preventDefault();
            e.stopPropagation();
            playButtonClick();
            window.location.href = '/articles/';
            break;
          case 'p':
            e.preventDefault();
            e.stopPropagation();
            playButtonClick();
            window.location.href = '/projects/';
            break;
          case 't':
            e.preventDefault();
            e.stopPropagation();
            playButtonClick();
            window.open('https://patents.justia.com/inventor/nikhil-b-lal', '_blank');
            break;
          case 'e':
            e.preventDefault();
            e.stopPropagation();
            playButtonClick();
            window.open('https://scholar.google.com/citations?user=GLdoyI4AAAAJ', '_blank');
            break;
          case 'g':
            e.preventDefault();
            e.stopPropagation();
            playButtonClick();
            window.open('https://github.com/nikhilblal', '_blank');
            break;
        }
      });

      // Close button functionality
      const closeBtn = document.querySelector('.close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', function() {
          playButtonClick();
          const floatingWindow = document.querySelector('.floating-window');
          if (floatingWindow) {
            floatingWindow.style.display = 'none';
          }
        });
      }
    });
  </script>
</head>
<body>
  <div class="grid">`;

  // Add all images from all projects
  for (const project of projects) {
    for (const image of project.images) {
      html += `<a href="${project.url}"><img src="${image}" alt="${project.title}" loading="lazy"></a>`;
    }
  }

  html += `</div>

  <div class="floating-window">
    <div class="window-header">
      <span class="window-title">Website Navigation</span>
      <div class="window-controls">
        <div class="window-button close-btn">×</div>
      </div>
    </div>
    <div class="window-content">
      <div class="dialog-section">
        <div class="exclamation-icon"></div>
        <div class="dialog-text">
          "Welcome to my website here you'll find nothing; here you'll find everything"<br><br>
          -Nikhil B. Lal
        </div>
      </div>
      <div class="button-section">
        <div class="button-group">
          <div class="button-group-label">Internal:</div>
          <div class="button-row">
            <a href="/about/" class="nav-button"><span class="shortcut">A</span>bout Me</a>
            <a href="/articles/" class="nav-button">A<span class="shortcut">r</span>ticles</a>
            <a href="/projects/" class="nav-button">All <span class="shortcut">P</span>rojects</a>
          </div>
        </div>
        <div class="button-group">
          <div class="button-group-label">External:</div>
          <div class="button-row">
            <a href="https://patents.justia.com/inventor/nikhil-b-lal" class="nav-button" target="_blank">Pa<span class="shortcut">t</span>ents</a>
            <a href="https://scholar.google.com/citations?user=GLdoyI4AAAAJ" class="nav-button" target="_blank">Pap<span class="shortcut">e</span>rs</a>
            <a href="https://github.com/nikhilblal" class="nav-button" target="_blank"><span class="shortcut">G</span>itHub</a>
          </div>
        </div>
      </div>
    </div>
  </div>

</body></html>`;

  await fs.writeFile(path.join(distDir, 'index.html'), html);
  console.log('Generated: image grid index.html');
}

async function build(isWatchMode = false) {
  const contentDir = path.join(__dirname, 'content');
  const distDir = path.join(__dirname, 'dist');

  // Only clean dist directory on initial build, not on watch rebuilds
  if (!isWatchMode) {
    await fs.rm(distDir, { recursive: true, force: true });
  }
  await ensureDir(distDir);

  // Copy assets
  await copyAssets();

  // Copy all project assets to main assets directory
  const projectsDir = path.join(contentDir, 'projects');
  const assetsDir = path.join(distDir, 'assets');
  await ensureDir(assetsDir);

  try {
    const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (dir.isDirectory()) {
        const projectDir = path.join(projectsDir, dir.name);
        const projectAssetDir = path.join(assetsDir, dir.name);

        // Copy all non-markdown files from project directory
        const files = await fs.readdir(projectDir, { withFileTypes: true });

        for (const file of files) {
          if (!file.name.endsWith('.md') && file.isFile()) {
            await ensureDir(projectAssetDir);
            await fs.copyFile(
              path.join(projectDir, file.name),
              path.join(projectAssetDir, file.name)
            );
          }
        }
      }
    }
  } catch (err) {
    // Projects directory might not exist
  }

  // Collect project images for grid
  const projects = await collectProjectImages();

  // Process all markdown files
  async function processDir(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        await processDir(fullPath);
      } else if (item.name.endsWith('.md')) {
        // Skip index.md - we'll generate our own
        if (path.relative(contentDir, fullPath) === 'index.md') {
          continue;
        }
        await processMarkdownFile(fullPath, contentDir, distDir);
      }
    }
  }

  try {
    await processDir(contentDir);
    // Generate the image grid homepage
    await generateImageGridIndex(projects);
    console.log('Build complete!');
  } catch (err) {
    console.error('Build failed:', err);
  }
}

// Watch mode
if (process.argv.includes('--watch')) {
  console.log('Starting watch mode...');

  // Do initial build (clean)
  await build(false);

  const watcher = chokidar.watch(['content/**/*.md', 'templates/**/*', 'src/**/*'], {
    ignoreInitial: true
  });

  watcher.on('ready', () => {
    console.log('Initial build complete. Watching for changes...');
  });

  watcher.on('change', async (path) => {
    console.log(`File changed: ${path}`);
    await build(true);
  });

  watcher.on('add', async (path) => {
    console.log(`File added: ${path}`);
    await build(true);
  });
} else {
  build(false);
}