import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { Eta } from 'eta';
import chokidar from 'chokidar';
import sharp from 'sharp';

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

async function optimizeImage(srcPath, destPath) {
  const ext = path.extname(srcPath).toLowerCase();

  try {
    if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      // Optimize images - resize to max 1200px width, compress to ~80% quality
      await sharp(srcPath)
        .resize(1200, null, {
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ quality: 80 })
        .png({ compressionLevel: 8 })
        .toFile(destPath);

      console.log(`Optimized image: ${path.basename(srcPath)}`);
    } else if (ext === '.gif') {
      // For GIFs: copy the original AND create a static thumbnail
      await fs.copyFile(srcPath, destPath);

      // Generate static thumbnail from first frame
      const staticPath = destPath.replace(/\.gif$/i, '-static.jpg');
      try {
        await sharp(srcPath, { animated: false })
          .resize(1200, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: 80 })
          .toFile(staticPath);
        console.log(`Created static thumbnail: ${path.basename(staticPath)}`);
      } catch (gifErr) {
        console.log(`Could not create static thumbnail for ${path.basename(srcPath)}`);
      }

      console.log(`Copied GIF: ${path.basename(srcPath)}`);
    } else {
      // Copy non-image files as-is
      await fs.copyFile(srcPath, destPath);
    }
  } catch (err) {
    console.log(`Failed to optimize ${srcPath}, copying as-is:`, err.message);
    await fs.copyFile(srcPath, destPath);
  }
}

async function collectReferencedImages() {
  const projectsDir = path.join(__dirname, 'content', 'projects');
  const referencedImages = new Map(); // Map of projectName -> Set of image filenames

  try {
    const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (dir.isDirectory()) {
        const projectPath = path.join(projectsDir, dir.name, 'index.md');
        const images = new Set();

        try {
          const content = await fs.readFile(projectPath, 'utf8');
          const { data: frontmatter, content: markdown } = matter(content);

          // Add featuredImage if present
          if (frontmatter.featuredImage) {
            let imagePath = frontmatter.featuredImage;
            // Extract just the filename
            const filename = imagePath.startsWith('./') ? imagePath.slice(2) : path.basename(imagePath);
            images.add(filename);
          }

          // Extract all image references from markdown
          const imageRegex = /!\[.*?\]\((.*?)\)/g;
          let match;

          while ((match = imageRegex.exec(markdown)) !== null) {
            let imagePath = match[1];
            // Skip external URLs
            if (!imagePath.startsWith('http')) {
              // Extract just the filename
              const filename = imagePath.startsWith('./') ? imagePath.slice(2) : path.basename(imagePath);
              images.add(filename);
            }
          }

          if (images.size > 0) {
            referencedImages.set(dir.name, images);
          }
        } catch (err) {
          // Skip if no index.md
        }
      }
    }
  } catch (err) {
    console.error('Error collecting referenced images:', err);
  }

  return referencedImages;
}

async function copyAssets() {
  const srcDir = path.join(__dirname, 'src');
  const distDir = path.join(__dirname, 'dist');

  // Copy from src/ to dist/
  try {
    const files = await fs.readdir(srcDir);
    for (const file of files) {
      const srcPath = path.join(srcDir, file);
      const distPath = path.join(distDir, file);

      const stat = await fs.stat(srcPath);
      if (stat.isFile()) {
        await optimizeImage(srcPath, distPath);
      }
    }
  } catch (err) {
    // src directory might not exist yet
  }

  // Copy from images/ to dist/assets/
  const imagesDir = path.join(__dirname, 'images');
  const assetsDir = path.join(distDir, 'assets');

  try {
    await ensureDir(assetsDir);
    const files = await fs.readdir(imagesDir);
    for (const file of files) {
      const srcPath = path.join(imagesDir, file);
      const distPath = path.join(assetsDir, file);

      const stat = await fs.stat(srcPath);
      if (stat.isFile()) {
        await optimizeImage(srcPath, distPath);
      }
    }
  } catch (err) {
    // images directory might not exist
  }

  // Copy CV PDF from content/ to dist/
  const cvSrc = path.join(__dirname, 'content', 'Curriculum_Vitae.pdf');
  const cvDest = path.join(distDir, 'Curriculum_Vitae.pdf');

  try {
    await fs.copyFile(cvSrc, cvDest);
    console.log('Copied Curriculum_Vitae.pdf');
  } catch (err) {
    // CV file might not exist
  }
}

async function copyProjectAssets(referencedImages) {
  const projectsDir = path.join(__dirname, 'content', 'projects');
  const distAssetsDir = path.join(__dirname, 'dist', 'assets');

  let copiedCount = 0;
  let skippedCount = 0;

  try {
    const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (dir.isDirectory()) {
        const projectPath = path.join(projectsDir, dir.name);
        const destPath = path.join(distAssetsDir, dir.name);
        const projectImages = referencedImages.get(dir.name);

        // Skip projects with no referenced images
        if (!projectImages || projectImages.size === 0) {
          continue;
        }

        // Only copy referenced images
        for (const imageName of projectImages) {
          const srcFile = path.join(projectPath, imageName);
          const destFile = path.join(destPath, imageName);

          try {
            await ensureDir(destPath);
            await optimizeImage(srcFile, destFile);
            copiedCount++;
          } catch (err) {
            console.log(`Warning: Could not copy ${imageName} from ${dir.name}`);
            skippedCount++;
          }
        }
      }
    }

    console.log(`Optimized ${copiedCount} referenced images, skipped ${skippedCount} missing`);
  } catch (err) {
    console.error('Error copying project assets:', err);
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
      await optimizeImage(srcPath, destPath);
    }
  }
}

async function processMarkdownFile(filePath, contentDir, distDir) {
  const content = await fs.readFile(filePath, 'utf8');
  const { data: frontmatter, content: markdown } = matter(content);

  // Get project name for asset path rewriting
  const relativePath = path.relative(contentDir, filePath);
  const parsedPath = path.parse(relativePath);
  const projectName = parsedPath.dir.split(path.sep)[1]; // e.g., "projects/covidshield" -> "covidshield"

  // Process YouTube shortcodes before markdown rendering
  let processedMarkdown = processYouTubeShortcodes(markdown);

  // Rewrite relative image paths to use /assets/ directory
  if (projectName) {
    processedMarkdown = processedMarkdown.replace(/!\[(.*?)\]\(\.\/([^)]+)\)/g, `![$1](/assets/${projectName}/$2)`);
    processedMarkdown = processedMarkdown.replace(/!\[(.*?)\]\((?!http|\/assets)([^)]+)\)/g, `![$1](/assets/${projectName}/$2)`);
  }

  const html = md.render(processedMarkdown);

  // Generate output path
  let outputPath;
  if (parsedPath.name === 'index') {
    outputPath = path.join(distDir, parsedPath.dir, 'index.html');
  } else {
    outputPath = path.join(distDir, parsedPath.dir, parsedPath.name, 'index.html');
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  await ensureDir(outputDir);

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

        // Only include projects with a date field and not explicitly marked as featured: false
        if (frontmatter.date !== undefined && frontmatter.featured !== false) {
          // Extract year from date field (handles formats like "2025", "2024-01-01", etc.)
          let year;
          if (typeof frontmatter.date === 'number') {
            year = frontmatter.date;
          } else if (typeof frontmatter.date === 'string') {
            const parsed = parseInt(frontmatter.date.split('-')[0]);
            year = isNaN(parsed) ? null : parsed;
          } else if (frontmatter.date instanceof Date) {
            year = frontmatter.date.getFullYear();
          } else {
            year = null;
          }

          // Skip projects without a valid year
          if (!year) {
            console.log(`Skipping project "${dir.name}": invalid date format`);
            continue;
          }

          const images = [];

          // Check for featuredImage in frontmatter first
          if (frontmatter.featuredImage) {
            let imagePath = frontmatter.featuredImage;
            // Convert relative paths to absolute asset paths
            if (imagePath.startsWith('./')) {
              imagePath = `/assets/${dir.name}/${imagePath.slice(2)}`;
            } else if (!imagePath.startsWith('http')) {
              imagePath = `/assets/${dir.name}/${imagePath}`;
            }
            images.push(imagePath);
          } else {
            // Fall back to extracting images from markdown
            const imageRegex = /!\[.*?\]\((.*?)\)/g;
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
          }

          if (images.length > 0) {
            // Process images to detect GIFs and add static versions
            const processedImages = images.map(img => {
              if (img.toLowerCase().endsWith('.gif')) {
                return {
                  static: img.replace(/\.gif$/i, '-static.jpg'),
                  animated: img,
                  isGif: true
                };
              }
              return {
                static: img,
                animated: img,
                isGif: false
              };
            });

            projects.push({
              name: dir.name,
              title: frontmatter.title || dir.name,
              images: processedImages,
              url: `/projects/${dir.name}/`,
              year: year
            });
          }
        }
      } catch (err) {
        // Skip if no index.md or other error
        console.log(`Error processing project "${dir.name}":`, err.message);
      }
    }
  }

  // Sort by year (descending - most recent first)
  projects.sort((a, b) => b.year - a.year);

  return projects;
}

async function generateImageGridIndex(projects) {
  const distDir = path.join(__dirname, 'dist');

  // Use the new grid template
  const pageData = {
    projects: projects
  };

  const renderedHtml = await eta.render('grid-index', pageData);
  await fs.writeFile(path.join(distDir, 'index.html'), renderedHtml);
  console.log('Generated: grid-index.html');
}

async function build(isWatchMode = false) {
  const contentDir = path.join(__dirname, 'content');
  const distDir = path.join(__dirname, 'dist');

  // Only clean dist directory on initial build, not on watch rebuilds
  if (!isWatchMode) {
    await fs.rm(distDir, { recursive: true, force: true });
  }
  await ensureDir(distDir);

  // Collect which images are actually referenced in markdown
  console.log('Scanning markdown for referenced images...');
  const referencedImages = await collectReferencedImages();

  // Copy src assets
  await copyAssets();

  // Copy only referenced project assets
  await copyProjectAssets(referencedImages);

  // Auto-generate missing project index.md files
  async function generateMissingProjectPages() {
    const projectsDir = path.join(contentDir, 'projects');
    try {
      const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });

      for (const dir of projectDirs) {
        if (dir.isDirectory()) {
          const indexPath = path.join(projectsDir, dir.name, 'index.md');

          try {
            await fs.access(indexPath);
            // File exists, skip
          } catch {
            // File doesn't exist, create it
            const title = dir.name
              .replace(/[-_]/g, ' ')
              .replace(/\b\w/g, l => l.toUpperCase());

            const defaultContent = `---
title: ${title}
template: page
---

# ${title}

Project documentation coming soon.
`;

            await fs.writeFile(indexPath, defaultContent);
            console.log(`Auto-generated index.md for project: ${dir.name}`);
          }
        }
      }
    } catch (err) {
      // Projects directory might not exist
    }
  }

  await generateMissingProjectPages();

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