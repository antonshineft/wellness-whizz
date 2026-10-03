/** All blog posts, newest first. Add a module under ./posts and list it here. */
import type { BlogPost } from './types';
import bestSupplementsForBloating from './posts/best-supplements-for-bloating';
import caseinVsWhey from './posts/casein-vs-whey-protein';
import creatineMonohydrateVsHcl from './posts/creatine-monohydrate-vs-hcl';
import magnesiumForms from './posts/magnesium-forms';
import omega3Guide from './posts/omega-3-guide';
import supplementsForEnergyAndFocus from './posts/supplements-for-energy-and-focus';
import vitaminD3Guide from './posts/vitamin-d3-guide';
import whenToTakeMagnesium from './posts/when-to-take-magnesium';
import zincPicolinateVsGluconate from './posts/zinc-picolinate-vs-zinc-gluconate';

export type { BlogPost } from './types';

export const POSTS: readonly BlogPost[] = [
  whenToTakeMagnesium,
  creatineMonohydrateVsHcl,
  caseinVsWhey,
  zincPicolinateVsGluconate,
  bestSupplementsForBloating,
  supplementsForEnergyAndFocus,
  magnesiumForms,
  omega3Guide,
  vitaminD3Guide,
].sort((a, b) => b.date.localeCompare(a.date));

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

/** Every supplement slug the posts refer to (hero images, shop blocks, inline <ww-shop> tags). */
export function supplementSlugsUsed(post: BlogPost): string[] {
  const slugs = new Set<string>([post.heroSupplement, ...post.shop]);
  for (const m of post.html.matchAll(/<ww-shop\s+slugs="([^"]+)"/g)) {
    m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => slugs.add(s));
  }
  return [...slugs];
}
