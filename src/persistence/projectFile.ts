/**
 * The .musiclab file format: a zip archive with
 *   project.json          - the Project (schemaVersion inside)
 *   audio/<assetId>/<fileName> - the original, unmodified audio file bytes
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { referencedAssetIds } from '../model/project';
import type { Id, Project } from '../model/types';
import { parseProject, ProjectFormatError } from '../model/validate';

export const PROJECT_EXTENSION = '.musiclab';
export const PROJECT_MIME = 'application/zip';

export interface ProjectBundle {
  project: Project;
  /** Original audio file bytes by asset id. */
  audio: Map<Id, Uint8Array>;
}

function assetPath(id: Id, fileName: string): string {
  const safe = fileName.replace(/[\\/:*?"<>|]/g, '_') || 'audio';
  return `audio/${id}/${safe}`;
}

/** Drop asset entries that no clip references (e.g. after deleting clips). */
export function pruneAssets(project: Project): Project {
  const used = referencedAssetIds(project);
  const assets: Project['assets'] = {};
  let changed = false;
  for (const [id, a] of Object.entries(project.assets)) {
    if (used.has(id)) assets[id] = a;
    else changed = true;
  }
  return changed ? { ...project, assets } : project;
}

export function writeProjectFile(bundle: ProjectBundle): Uint8Array {
  const project = pruneAssets(bundle.project);
  const files: Zippable = {
    'project.json': strToU8(JSON.stringify(project, null, 2)),
  };
  for (const asset of Object.values(project.assets)) {
    const bytes = bundle.audio.get(asset.id);
    if (!bytes) throw new Error(`Missing audio data for "${asset.fileName}"`);
    // Audio is already compressed (or incompressible PCM); store without deflate.
    files[assetPath(asset.id, asset.fileName)] = [bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

export function readProjectFile(data: Uint8Array): ProjectBundle {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    throw new ProjectFormatError('Not a valid .musiclab file (could not unzip).');
  }
  const json = entries['project.json'];
  if (!json) throw new ProjectFormatError('Not a valid .musiclab file (project.json missing).');
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(json));
  } catch {
    throw new ProjectFormatError('project.json is not valid JSON.');
  }
  const project = parseProject(raw);
  const audio = new Map<Id, Uint8Array>();
  for (const asset of Object.values(project.assets)) {
    const bytes = entries[assetPath(asset.id, asset.fileName)];
    if (!bytes) throw new ProjectFormatError(`Audio file for "${asset.fileName}" is missing from the archive.`);
    audio.set(asset.id, bytes);
  }
  return { project, audio };
}
