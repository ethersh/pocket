#!/usr/bin/env node
import path from 'node:path';
import { HELP, UsageError, parseOptions, type Options } from './options.ts';
import { defaultBundleId, internalHosts, readInjections, rememberedTeam, targetName, writeProject, assertWritable, type Plan } from './render.ts';
import { inspectSite, nameFromHost, type SiteInfo } from './site.ts';
import { assertXcode, buildIpa, makeIcon, openInXcode, findDevice, resolveTeam, runInSimulator, runOnDevice, type Device, type Team } from './xcode.ts';

const log = (line: string) => console.log(line);

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options === 'help') { log(HELP); return; }
  await assertXcode();

  const injections = await readInjections(options.inject);
  let site: SiteInfo & { warning?: string } = { icons: [] };
  if (!options.offline) {
    log(`Reading ${options.url.host}…`);
    site = await inspectSite(options.url);
    if (site.warning) log(`  ${site.warning}`);
  }

  const displayName = options.name ?? site.name ?? nameFromHost(options.url.hostname);
  const target = targetName(displayName);
  const outDir = path.resolve(options.out ?? target);
  // Device builds must be signed, so settle the team and the phone before anything is written; a team used for
  // this project before is remembered either way.
  const remembered = await rememberedTeam(outDir);
  let team: Team | undefined;
  let device: Device | undefined;
  if (options.device) {
    team = await resolveTeam(options.team, remembered);
    device = await findDevice(options.deviceName);
  }
  options.team = team?.id ?? (options.team || remembered);
  const plan: Plan = {
    displayName,
    target,
    bundleId: options.bundleId ?? defaultBundleId(displayName, options.team),
    outDir,
    themeColor: options.themeColor ?? site.themeColor,
    internalHosts: internalHosts(options.url, options.internalHosts),
    ...injections,
  };
  await assertWritable(plan.outDir, options.force);

  const icon = await makeIcon(options.icon ? [options.icon] : site.icons, displayName, plan.themeColor);
  if (options.icon && icon.source === 'monogram') throw new UsageError(`Couldn't read ${options.icon} as a PNG, JPEG or ICO image`);
  await writeProject(options, plan, icon.png);

  log(`\n${displayName} → ${path.relative(process.cwd(), plan.outDir) || '.'}`);
  log(`  bundle id     ${plan.bundleId}`);
  log(`  icon          ${icon.source}`);
  log(`  dynamic type  ${describeDynamicType(options)}`);
  log(`  edges         ${options.edges}${plan.themeColor ? ` · ${plan.themeColor}` : ''}`);
  log(`  internal      ${plan.internalHosts.join(', ')}\n`);

  if (options.run) await runInSimulator(plan, options.simulator, log);
  if (team && device) await runOnDevice(plan, team, device, log);
  if (options.ipa) log(`Unsigned IPA: ${path.relative(process.cwd(), await buildIpa(plan, log))}`);
  if (options.open) await openInXcode(plan);
  if (!options.run && !options.device && !options.ipa && !options.open) {
    const rerun = `pocket ${options.url.href} --out ${path.relative(process.cwd(), plan.outDir) || '.'}`;
    log(`Next: open ${path.join(path.relative(process.cwd(), plan.outDir), `${target}.xcodeproj`)} and press Run,\n      or re-run with --run (simulator), --device (your iPhone) or --ipa (unsigned build): ${rerun} --run`);
  }
}

function describeDynamicType(options: Options): string {
  if (options.dynamicType === 'off') return 'off';
  return `${options.dynamicType} · ${options.minTextScale}×–${options.maxTextScale}×`;
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) console.error(`pocket: ${error.message}\nRun pocket --help for usage.`);
  else console.error(`pocket: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
