import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_DIR = '/Users/nikhil/portfolio_docs/src/content/docs';
const TARGET_DIR = path.join(__dirname, 'content/projects');
const ASSETS_DIR = path.join(__dirname, 'src/assets');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function copyFile(src, dest) {
  try {
    await ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
    console.log(`Copied: ${src} -> ${dest}`);
  } catch (err) {
    console.error(`Failed to copy ${src}: ${err.message}`);
  }
}

async function processProject(projectDir) {
  const projectName = path.basename(projectDir);
  const cleanName = projectName.replace(/^\d+\.\d+___/, '').toLowerCase();

  console.log(`Processing project: ${projectName} -> ${cleanName}`);

  const targetProjectDir = path.join(TARGET_DIR, cleanName);
  const targetAssetsDir = path.join(ASSETS_DIR, cleanName);

  await ensureDir(targetProjectDir);
  await ensureDir(targetAssetsDir);

  // Read the index.md file
  const indexPath = path.join(projectDir, 'index.md');
  try {
    let content = await fs.readFile(indexPath, 'utf8');

    // Update frontmatter to include template
    if (content.startsWith('---')) {
      const frontmatterEnd = content.indexOf('---', 3);
      const frontmatter = content.slice(3, frontmatterEnd);
      const body = content.slice(frontmatterEnd + 3);

      // Add template: page to frontmatter
      const updatedFrontmatter = frontmatter.trim() + '\ntemplate: page\n';
      content = `---\n${updatedFrontmatter}---${body}`;
    }

    // Write the markdown file
    await fs.writeFile(path.join(targetProjectDir, 'index.md'), content);
    console.log(`Created: ${cleanName}/index.md`);

    // Copy all asset files (images, videos, etc.)
    const files = await fs.readdir(projectDir);
    for (const file of files) {
      if (file !== 'index.md') {
        const srcFile = path.join(projectDir, file);
        const destFile = path.join(targetAssetsDir, file);

        const stat = await fs.stat(srcFile);
        if (stat.isFile()) {
          await copyFile(srcFile, destFile);

          // Also copy to project directory for relative references
          const relativeDestFile = path.join(targetProjectDir, file);
          await copyFile(srcFile, relativeDestFile);
        }
      }
    }

  } catch (err) {
    console.error(`Error processing ${projectName}: ${err.message}`);
  }
}

async function migrateAllProjects() {
  try {
    const projects = await fs.readdir(SOURCE_DIR);

    for (const project of projects) {
      if (project.startsWith('.')) continue; // Skip hidden files

      const projectPath = path.join(SOURCE_DIR, project);
      const stat = await fs.stat(projectPath);

      if (stat.isDirectory()) {
        await processProject(projectPath);
      }
    }

    console.log('Migration complete!');
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

migrateAllProjects();