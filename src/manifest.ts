import { z } from "zod";

const CloneUrl = z
  .string()
  .url()
  .refine((u) => {
    const p = new URL(u);
    return p.protocol === "https:" && !p.username && !p.password;
  }, "must be an https:// URL without credentials");

const Browse = z.string().regex(/^[^\t\r\n]+$/, "must be one line without tabs");

export const RepoEntry = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1),
  url: CloneUrl.optional(),
  browse: Browse.optional(),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

export const RepoManifest = z.object({
  profile: z.string().min(1),
  created_at: z.iso.datetime(),
  repos: z.array(RepoEntry).min(1),
});
export type RepoManifest = z.infer<typeof RepoManifest>;

/** One configured repository: where to clone it from and how to link to it. */
const RepoSource = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z.string().min(1).optional(),
  url: CloneUrl.optional(),
  browse: Browse.optional(),
});

export const RepoProfile = z.object({
  name: z.string().min(1),
  repos: z.array(RepoSource).min(1),
});
export type RepoProfile = z.infer<typeof RepoProfile>;
