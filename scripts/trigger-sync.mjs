// Trigger Boonphone sync directly by calling the runner
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Use tsx to run the TypeScript sync runner directly
import { execSync } from 'child_process';

console.log('Triggering Boonphone sync...');
try {
  const result = execSync(
    'npx tsx -e "import { runSectionSync } from \'./server/sync/runner\'; runSectionSync(\'Boonphone\', \'manual\').then(() => { console.log(\'Sync complete\'); process.exit(0); }).catch(e => { console.error(\'Sync error:\', e.message); process.exit(1); });"',
    { cwd: '/home/ubuntu/report-system', timeout: 600000, encoding: 'utf8', stdio: 'pipe' }
  );
  console.log(result);
} catch (e) {
  console.error('Error:', e.message);
  if (e.stdout) console.log('stdout:', e.stdout);
  if (e.stderr) console.error('stderr:', e.stderr);
}
