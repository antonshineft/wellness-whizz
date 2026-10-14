/** All blog posts, newest first. Add a module under ./posts and list it here. */
import type { BlogPost } from './types';
import bestSupplementsForAnxiety from './posts/best-supplements-for-anxiety';
import bestSupplementsForBloating from './posts/best-supplements-for-bloating';
import bestSupplementsForEyeHealth from './posts/best-supplements-for-eye-health';
import bestVitaminsForWomen from './posts/best-vitamins-for-women';
import caseinVsWhey from './posts/casein-vs-whey-protein';
import citrullineVsCitrullineMalate from './posts/citrulline-vs-citrulline-malate';
import coq10VsUbiquinol from './posts/coq10-vs-ubiquinol';
import creatineMonohydrateVsHcl from './posts/creatine-monohydrate-vs-hcl';
import glynacAgingTrial from './posts/glynac-glycine-nac-aging-trial';
import howMuchProtein from './posts/how-much-protein-do-i-need';
import nacDosage from './posts/nac-dosage';
import berberineDosage from './posts/berberine-dosage';
import taurineDosage from './posts/taurine-dosage';
import alphaGpcDosage from './posts/alpha-gpc-dosage';
import lTyrosineDosage from './posts/l-tyrosine-dosage';
import gabaDosage from './posts/gaba-dosage';
import melatoninDosage from './posts/melatonin-dosage';
import lemonBalmDosage from './posts/lemon-balm-dosage';
import lionsManeDosage from './posts/lions-mane-dosage';
import citrullineDosage from './posts/citrulline-dosage';
import nattokinaseDosage from './posts/nattokinase-dosage';
import valerianRootDosage from './posts/valerian-root-dosage';
import tartCherryDosage from './posts/tart-cherry-dosage';
import shilajitDosage from './posts/shilajit-dosage';
import fenugreekDosage from './posts/fenugreek-dosage';
import msmDosage from './posts/msm-dosage';
import hyaluronicAcidDosage from './posts/hyaluronic-acid-dosage';
import psylliumHuskDosage from './posts/psyllium-husk-dosage';
import quercetinDosage from './posts/quercetin-dosage';
import lTheanineAndCaffeine from './posts/l-theanine-and-caffeine';
import fishOilBeforeBedOrMorning from './posts/fish-oil-before-bed-or-morning';
import ashwagandhaEstrogenTestosteroneLibido from './posts/ashwagandha-estrogen-testosterone-libido';
import bestSupplementsToGainMuscle from './posts/best-supplements-to-gain-muscle';
import glucosamineSulfateVsHydrochloride from './posts/glucosamine-sulfate-vs-hydrochloride';
import folateVsMethylfolate from './posts/folate-vs-methylfolate';
import alphaGpcVsCiticoline from './posts/alpha-gpc-vs-citicoline';
import magnesiumForms from './posts/magnesium-forms';
import omega3Guide from './posts/omega-3-guide';
import supplementsForEnergyAndFocus from './posts/supplements-for-energy-and-focus';
import vitaminD3AndK2 from './posts/vitamin-d3-and-k2';
import vitaminD3Guide from './posts/vitamin-d3-guide';
import whenToTakeMagnesium from './posts/when-to-take-magnesium';
import wheyIsolateVsConcentrate from './posts/whey-isolate-vs-concentrate';
import zincPicolinateVsGluconate from './posts/zinc-picolinate-vs-zinc-gluconate';

export type { BlogPost } from './types';

export const POSTS: readonly BlogPost[] = [
  howMuchProtein,
  nacDosage,
  berberineDosage,
  taurineDosage,
  alphaGpcDosage,
  lTyrosineDosage,
  gabaDosage,
  melatoninDosage,
  lemonBalmDosage,
  lionsManeDosage,
  citrullineDosage,
  nattokinaseDosage,
  valerianRootDosage,
  tartCherryDosage,
  shilajitDosage,
  fenugreekDosage,
  msmDosage,
  hyaluronicAcidDosage,
  psylliumHuskDosage,
  quercetinDosage,
  lTheanineAndCaffeine,
  fishOilBeforeBedOrMorning,
  ashwagandhaEstrogenTestosteroneLibido,
  bestSupplementsToGainMuscle,
  glucosamineSulfateVsHydrochloride,
  folateVsMethylfolate,
  alphaGpcVsCiticoline,
  glynacAgingTrial,
  bestVitaminsForWomen,
  bestSupplementsForAnxiety,
  bestSupplementsForEyeHealth,
  wheyIsolateVsConcentrate,
  vitaminD3AndK2,
  citrullineVsCitrullineMalate,
  coq10VsUbiquinol,
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
