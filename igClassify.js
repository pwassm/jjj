#!/usr/bin/env node
// igClassify.js — first-pass subject classifier for ig.json rows (CAPTION ONLY).
//
//   node igClassify.js --author schmidtocean          (one or more, comma-separated)
//   node igClassify.js --all                          (every row)
//   node igClassify.js --author x --no-lookup         (skip WoRMS/GBIF, cache only)
//
// Reads ig.json + tags.json + commonwords.txt, never writes ig.json. Results go to a
// SIDECAR, igclass.json, keyed by shortcode id, so the 220MB ig.json isn't rewritten
// and the I screen / proxy writers aren't raced. Entries with by:'human' are never
// overwritten. igclass.review.json (the rows of THIS run, with a caption snippet +
// first media file) feeds igclass.html. Latin binomials found in captions resolve
// WoRMS FIRST, GBIF only for names WoRMS misses; both cached in igclass.taxa.json.
//
// Tags:   media   photo · video · carousel
//         subject fish · marine-not-fish · bird · other-animal · plant · mushroom · animal (unspecified)
//         scale   micro (under a microscope) · macromicro (close-up of a small creature)
//         other   people · lecture · landscape · gear · cartoon
// verdict keep (a subject, nothing strongly against) · mixed (a subject AND a strong
//         about-a-person/event/art/scene cue) · drop (no subject, unwanted cues) · unknown
// A diver WITH an animal is the animal; divers alone are people.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const IG = path.join(ROOT, 'ig.json');
const OUT = path.join(ROOT, 'igclass.json');
const REVIEW = path.join(ROOT, 'igclass.review.json');
const TAXA = path.join(ROOT, 'igclass.taxa.json');
const LABELS = path.join(ROOT, 'igclass.labels.json');   // igclass.html ✗ corrections (proxy /ig/class-label)
const CLIPF = path.join(ROOT, 'igclass.clip.json');      // igclip.py frames + CLIP/BioCLIP
const CLASSIFIER = 'caption-v2';

// ---------- args ----------
const argv = process.argv.slice(2);
const argVal = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ALL = argv.includes('--all');
const AUTHORS = (argVal('--author') || '').split(',').map(s => s.trim()).filter(Boolean);
const NO_LOOKUP = argv.includes('--no-lookup');
if (!ALL && !AUTHORS.length) { console.log('usage: node igClassify.js --author <name[,name]> | --all [--no-lookup]'); process.exit(1); }

// ---------- lexicon ----------
// Specific subject terms (weight 2). Plurals (s/es) are matched automatically.
const LEX = {
  fish: `fish,shark,ray,stingray,eagle ray,devil ray,electric ray,manta,mobula,skate,eel,moray,seahorse,sea horse,pipefish,seadragon,sea dragon,goby,gobies,blenny,blennies,wrasse,grouper,snapper,tuna,anglerfish,frogfish,scorpionfish,lionfish,pufferfish,puffer,boxfish,cowfish,triggerfish,filefish,damselfish,clownfish,anemonefish,butterflyfish,angelfish,parrotfish,barracuda,trevally,mackerel,sardine,herring,anchovy,anchovies,cod,hake,grenadier,rattail,lanternfish,dragonfish,viperfish,hatchetfish,barreleye,bristlemouth,snailfish,cusk-eel,cusk eel,hagfish,lamprey,chimaera,ratfish,ghost shark,coelacanth,flounder,halibut,flatfish,garden eel,sea robin,searobin,tripodfish,tripod fish,batfish,sunfish,mola,remora,cardinalfish,hawkfish,jawfish,dragonet,mandarinfish,sweetlips,rockfish,sculpin,lumpsucker,icefish,toadfish,stonefish,flying fish,needlefish,fangtooth,gulper,swallower,oarfish,blobfish,whale shark,cat shark,snake eel,bat ray,hammerhead,catshark,wobbegong,guitarfish,sawfish,bass,trout,salmon,carp,minnow,cichlid,tetra,guppy,piranha,catfish,pez,peces,tiburon,raya,caballito de mar`,
  // Sea slugs get their own tag (user, dev1005) — most will be nudibranchs.
  seaslug: `nudibranch,nudi,sea slug,seaslug,sea hare,sea angel,sacoglossan,headshield slug,pleurobranch,aeolid,dorid,spanish dancer,chromodoris,hypselodoris,flabellina,glaucus,blue dragon,phyllidia,elysia,costasiella,leaf sheep,babosa de mar,babosa marina`,
  'marine-not-fish': `octopus,octopuses,octopi,squid,cuttlefish,nautilus,cephalopod,sea snail,snail,clam,mussel,oyster,scallop,limpet,chiton,jellyfish,jelly,jellies,siphonophore,ctenophore,comb jelly,comb jellies,coral,sea fan,gorgonian,sea pen,sea whip,anemone,hydroid,hydromedusa,hydromedusae,medusa,medusae,sponge,sea star,starfish,brittle star,basket star,sea urchin,urchin,sea cucumber,holothurian,crinoid,feather star,sea lily,sea lilies,crab,shrimp,lobster,prawn,krill,copepod,amphipod,isopod,barnacle,mantis shrimp,squat lobster,hermit crab,sea spider,polychaete,bristle worm,tube worm,tubeworm,christmas tree worm,flatworm,ribbon worm,worm,salp,pyrosome,larvacean,tunicate,sea squirt,ascidian,bryozoan,whale,dolphin,porpoise,orca,seal,sea lion,walrus,manatee,dugong,sea otter,sea turtle,turtle,sea snake,pteropod,sea butterfly,sea butterflies,marine mammal,spider crab,bat star,goose barnacle,heteropod,plankton,zooplankton,phytoplankton,larva,larvae,paralarva,phyllosoma,cnidarian,echinoderm,crustacean,mollusc,mollusk,invertebrate,foraminifera,foram,radiolarian,diatom,dinoflagellate,pulpo,calamar,cangrejo,estrella de mar,erizo,ballena,delfin,tortuga,medusa`,
  bird: `bird,seabird,gull,tern,pelican,cormorant,penguin,albatross,puffin,gannet,booby,boobies,heron,egret,frigatebird,shearwater,petrel,owl,eagle,osprey,hawk,hummingbird,duck,goose,geese,swan,sandpiper,plover,kingfisher,woodpecker,parrot,songbird,aves,pajaro`,
  'other-animal': `insect,spider,beetle,butterfly,butterflies,moth,caterpillar,ants,bee,wasp,dragonfly,dragonflies,mantis,grasshopper,housefly,frog,toad,salamander,newt,axolotl,lizard,gecko,chameleon,iguana,tortoise,crocodile,alligator,snake,mammal,cat,dog,bats,mouse,mice,squirrel,deer,bears,monkey,fox,wolf,rabbit,tardigrade,mite,scorpion,millipede,centipede,earthworm,slug`,
  plant: `plant,flower,seagrass,eelgrass,mangrove,moss,fern,tree,leaf,leaves,wildflower,orchid,cactus,cacti,planta`,
  // Algae are not plants (user, dev1005).
  algae: `algae,alga,seaweed,kelp,macroalgae,sargassum,coralline algae,red algae,green algae,brown algae,rhodolith,algas`,
  mushroom: `mushroom,fungus,fungi,fungal,slime mold,slime mould,myxomycete,myxo,mycelium,toadstool,bolete,amanita,morel,chanterelle,puffball,cup fungus,lichen,hongo,hongos,seta`,
};
// Words that are as often an idiom, a verb or poetry as an organism ("seal the deal", "sun
// rays", "rocking-with-wind trees"). They count only when nothing specific was found, or
// when their own group already has a specific hit.
const WEAK_SUBJ = new Set(`spanish dancer,seal,snail,jelly,jellies,sponge,tree,leaf,leaves,flower,plant,ray,skate,bass,cod,mola,cat,snake,slug,moss,fern,worm,larva,larvae,coral,algae,alga,planta,pez,raya,seta,nudi,glaucus,elysia`.split(','));
// Generic "an animal is here" (weight 1) — keeps a row out of drop, can't say which.
const ANIMAL_GENERIC = `animal,creature,critter,organism,wildlife,marine life,sea life,sealife,new species,species,fauna,especie,especies`;

// Scale cues. STRONG micro alone decides; weak micro needs two.
const MICRO_STRONG = `microscope,microscopy,micrograph,photomicrograph,photomicrography,under the microscope,under a microscope,confocal,electron microscope,electron micrograph,scanning electron,brightfield,darkfield,dark field,dark-field,phase contrast,differential interference,polarized light,polarization microscope,polychromatic polarization,diatom,radiolarian,radiolaria,foraminifera,foraminiferan,dinoflagellate,ciliate,rotifer,protist,tardigrade,microscopymonday,microscopemonday`;
const MICRO_WEAK = `magnification,magnified,objective,fluorescence,fluorescent,micron,microns,micrometer,micrometre`;
// Talking ABOUT microbes isn't a micrograph (vent mats, "microbial life"): counts only beside an optics cue.
const MICRO_TALK = `bacteria,bacterium,microbe,microbial,microscopic,single-celled,unicellular,cells,cell`;
const MACRO = `macro,macrophotography,macro photography,supermacro,super macro,blackwater,black water,larva,larvae,larval,paralarva,plankton,planktonic,zooplankton,tiny,minuscule,pinhead,grain of rice,fingernail,millimeter,millimetre`;

// Unwanted classes: STRONG = "the post is ABOUT this" (can override a subject → mixed);
// weak = context only (recorded, never overrides a subject).
const UNWANTED = {
  people: {
    strong: `spotlight,meet,pictured,from left,left to right,portrait,selfie,interview,graduation,graduate,congratulations,congrats,birthday,in memoriam,our team,team member,group photo,welcome aboard,alumni,career,careers,day in the life`,
    weak: `award,team,crew,scientist,researcher,student,people,person,kids,children,fellow,fellowship,intern,internship,mentor,faculty,staff,volunteer,engineer,captain,diver,divers,cientificos,equipo`,
  },
  lecture: {
    strong: `webinar,lecture,seminar,symposium,keynote,ship-to-shore,ship to shore,tune in,join us live,presentation,panel discussion,podcast,explainer,conference,workshop,save the date,register now,registration,open house,q&a`,
    weak: `livestream,live stream,talk,talks,explains,episode,course,class,classroom,teacher,teaching,educator,event,join us,watch the full,video series,curso`,
  },
  landscape: {
    strong: `sunset,sunrise,landscape,seascape,aerial,drone shot,golden hour,rainbow,night sky,milky way,glacier,iceberg`,
    weak: `horizon,view from,views of,coastline,coast,beach,shore,wetland,marsh,estuary,sea ice,mountain,volcano,island,storm,cloud,sky,skies,waves,fjord,cliff,dune,lagoon,atoll,scenery`,
  },
  gear: {
    strong: `control room,multibeam,mooring,winch,hydrophone,deployment,deployed,recovery of the,sampler,glider,lander,autonomous underwater vehicle,seafloor mapping`,
    weak: `rov,subastian,vessel,ship,falkor,aboard,onboard,on board,instrument,sensor,technology,engineering,robot,robotic,lab,laboratory,mapping,sonar,ctd,auv,camera system,laboratorio,buque`,
  },
  cartoon: {
    strong: `#sciartfriday,#sciartsaturday,#sciart,#artistatsea,cartoon,illustration,illustrated,drawing,painting,painted,sketch,watercolor,watercolour,artwork,animation,animated,comic,infographic,coloring page,3d model,3d render,ai-generated,ai generated`,
    weak: `art,artist,artist-at-sea,poster,diagram,map,graphic`,
  },
};

// ---------- tags.json → extra subject terms ----------
function tagsLexicon() {
  const extra = {}; // group -> Set(term)
  let t; try { t = JSON.parse(fs.readFileSync(path.join(ROOT, 'tags.json'), 'utf8')); } catch (e) { return extra; }
  const rows = t.filter(x => x && x.id && !x._salMeta);
  const byId = new Map(rows.map(x => [x.id, x]));
  // Nearest anchor wins (BFS up the parents chain). Order within a level doesn't matter much.
  const ANCHOR = {
    actinopterygii: 'fish', teleostei: 'fish', elasmobranchii: 'fish', fish: 'fish', 'snipe-eel': 'fish', 'moray-eel': 'fish',
    aves: 'bird', bird: 'bird',
    // A sea-life dictionary: its mammals/reptiles are whales, seals, sea turtles, sea snakes.
    mammalia: 'marine-not-fish', mammal: 'marine-not-fish', squamata: 'marine-not-fish', reptile: 'marine-not-fish',
    amphibia: 'other-animal', amphibian: 'other-animal', insect: 'other-animal', arachnid: 'other-animal',
    phaeophyceae: 'algae', bacillariophyceae: 'micro', diaatom: 'micro',
    nudibranchia: 'seaslug', nudibranch: 'seaslug', 'sea-slug': 'seaslug', aplysiida: 'seaslug', sacoglossa: 'seaslug', cephalaspidea: 'seaslug', pleurobranchida: 'seaslug',
    'slime-mold': 'mushroom',
    chromista: 'micro', protozoa: 'micro', retaria: 'micro', polycystinea: 'micro', filosia: 'micro', endomyxa: 'micro', sarcodina: 'micro', labyrinthulea: 'micro',
    tardigrada: 'micro', rotifera: 'micro', gastrotricha: 'micro', loricifera: 'micro', bamfordvirae: 'micro',
    animalia: 'marine-not-fish',
  };
  const anchorOf = id => {
    const seen = new Set(); let frontier = [id];
    while (frontier.length) {
      for (const f of frontier) if (ANCHOR[f]) return ANCHOR[f];
      const next = [];
      for (const f of frontier) { if (seen.has(f)) continue; seen.add(f); const r = byId.get(f); if (r && r.parents) next.push(...r.parents); }
      frontier = next;
    }
    return null;
  };
  for (const r of rows) {
    if (r.kind !== 'taxon' && r.kind !== 'group') continue;
    const g = anchorOf(r.id); if (!g) continue;
    const names = [r.label, r.common, r.id.replace(/-/g, ' '), ...(r.aliases || [])].filter(Boolean);
    for (let n of names) {
      n = norm(String(n)).trim();
      if (n.length < 4 || !/[a-z]{3}/.test(n) || /\d/.test(n) || /^(life|other|health|activity|fish|bird|mammal|insect)$/.test(n)) continue;
      (extra[g] = extra[g] || new Set()).add(n);
    }
  }
  return extra;
}

// ---------- text ----------
function norm(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .toLowerCase();
}
function decodeEnt(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&nbsp;/g, ' ');
}
// Caption body only: drop the <h2> (a copy of line 1) and the "By @x · date" + "Source:" footer.
function captionOf(r) {
  let h = String(r.ftext || r.ttxt || '');
  h = h.replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, ' ')
       .replace(/<p[^>]*color:#888[^>]*>[\s\S]*?<\/p>/gi, ' ')
       .replace(/<p>\s*Source:[\s\S]*?<\/p>/gi, ' ');
  h = decodeEnt(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' '));
  const extra = [r.DevComment].filter(Boolean).join('\n');   // the user's own curated label
  return (extra ? extra + '\n' : '') + h.replace(/[ \t]+/g, ' ').trim();
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termRegex(terms) {
  const list = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length)
    .map(t => esc(t).replace(/\s+/g, '[\\s-]+'));
  return new RegExp('(?<![\\w])(' + list.join('|') + ')(?:e?s)?(?![\\w])', 'g');
}
const splitTerms = s => s.split(',').map(x => norm(x.trim())).filter(Boolean);

// ---------- WoRMS → GBIF ----------
function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } }
function writeJsonAtomic(p, obj, pretty) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 1 : 0));
  fs.renameSync(tmp, p);
}
const FISH_CLASSES = /^(actinopteri|actinopterygii|teleostei|elasmobranchii|holocephali|chondrichthyes|myxini|petromyzonti|cephalaspidomorphi|coelacanthi|dipneusti|sarcopterygii|cladistii|chondrostei|holostei)$/i;
const SEASLUG_ORDERS = /^(nudibranchia|aplysiida|anaspidea|sacoglossa|cephalaspidea|pleurobranchida|pleurobranchomorpha|umbraculida|runcinida|pteropoda|gymnosomata)$/i;
function groupOfTaxon(t) {
  if (!t || t.src === 'none') return null;
  const k = (t.kingdom || '').toLowerCase(), p = (t.phylum || '').toLowerCase(), c = (t.class || '').toLowerCase();
  if (c === 'myxomycetes' || p === 'mycetozoa') return { g: 'mushroom' };
  if (k === 'fungi') return { g: 'mushroom' };
  // Algae are not plants: red/green algae sit in WoRMS Plantae, kelps in Chromista.
  if (k === 'plantae') return /^(rhodophyta|chlorophyta|charophyta)$/.test(p) ? { g: 'algae' } : { g: 'plant' };
  if (k === 'chromista') return c === 'phaeophyceae' ? { g: 'algae' } : { g: 'marine-not-fish', s: 'micro' };
  if (k === 'protozoa') return { g: 'marine-not-fish', s: 'micro' };
  if (k === 'bacteria' || k === 'archaea' || k === 'viruses') return { g: null, s: 'micro' };
  if (k === 'animalia') {
    if (FISH_CLASSES.test(c)) return { g: 'fish' };
    if (c === 'aves') return { g: 'bird' };
    if (SEASLUG_ORDERS.test(t.order || '')) return { g: 'seaslug' };
    const s =/^(tardigrada|rotifera|gastrotricha|loricifera)$/.test(p) ? 'micro' : undefined;
    // WoRMS flags are 1/0/null; only an explicit not-marine is a land/freshwater animal.
    if (t.src === 'worms') return { g: t.isMarine === 0 || t.isMarine === false ? 'other-animal' : 'marine-not-fish', s };
    const marinePhyla = /^(cnidaria|echinodermata|ctenophora|porifera|brachiopoda|chaetognatha|bryozoa)$/;
    return { g: (marinePhyla.test(p) || /^(cephalopoda|malacostraca|polychaeta|ascidiacea|thaliacea)$/.test(c)) ? 'marine-not-fish' : 'other-animal', s };
  }
  return null;
}
async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'SLAM igClassify (local)' } });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(res.status + ' ' + url);
  const txt = await res.text(); return txt ? JSON.parse(txt) : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function resolveNames(names, cache) {
  const todo = names.filter(n => !(n in cache));
  if (!todo.length || NO_LOOKUP) return { worms: 0, gbif: 0, asked: todo.length };
  let worms = 0, gbif = 0;
  // WoRMS first — batches of 50.
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const qs = batch.map(n => 'scientificnames[]=' + encodeURIComponent(n)).join('&');
    let res = null;
    try { res = await fetchJson('https://www.marinespecies.org/rest/AphiaRecordsByMatchNames?' + qs + '&marine_only=false'); }
    catch (e) { console.warn('  WoRMS batch failed:', e.message); }
    batch.forEach((n, j) => {
      const hits = res && Array.isArray(res[j]) ? res[j] : [];
      const h = hits.find(x => x && /^(exact|exact_genus|exact_subgenus|phonetic)$/.test(x.match_type || '')) || null;
      if (h && h.kingdom) {
        cache[n] = { src: 'worms', valid: h.valid_name || h.scientificname, rank: h.rank, kingdom: h.kingdom, phylum: h.phylum, class: h.class, order: h.order,
          isMarine: h.isMarine, isTerrestrial: h.isTerrestrial, isFreshwater: h.isFreshwater };
        worms++;
      }
    });
    await sleep(250);
  }
  // GBIF only for what WoRMS didn't know.
  for (const n of todo.filter(n => !(n in cache))) {
    try {
      const g = await fetchJson('https://api.gbif.org/v1/species/match?strict=true&name=' + encodeURIComponent(n));
      if (g && g.kingdom && (g.matchType === 'EXACT' || (g.matchType === 'FUZZY' && g.confidence >= 95))) {
        cache[n] = { src: 'gbif', valid: g.canonicalName || g.scientificName, rank: g.rank, kingdom: g.kingdom, phylum: g.phylum, class: g.class, order: g.order };
        gbif++;
      } else cache[n] = { src: 'none' };
    } catch (e) { console.warn('  GBIF failed for', n, e.message); }
    await sleep(150);
  }
  return { worms, gbif, asked: todo.length };
}

// ---------- main ----------
(async () => {
  const t0 = Date.now();
  const all = JSON.parse(fs.readFileSync(IG, 'utf8'));
  const rows = ALL ? all : all.filter(r => AUTHORS.includes(r.author));
  if (!rows.length) { console.log('no rows for', AUTHORS.join(',')); process.exit(1); }
  console.log(`${rows.length} rows (${ALL ? 'all' : AUTHORS.join(', ')}) · ig.json read in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const common = new Set(fs.readFileSync(path.join(ROOT, 'commonwords.txt'), 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean));
  const tagsLex = tagsLexicon();

  // Subject regexes: hand lexicon + tags.json names. tags.json 'micro' anchors become micro cues.
  const subjRe = {}, subjTerms = {};
  for (const g of Object.keys(LEX)) subjTerms[g] = splitTerms(LEX[g]).concat([...(tagsLex[g] || [])]);
  for (const g of Object.keys(subjTerms)) subjRe[g] = termRegex(subjTerms[g]);
  const genericRe = termRegex(splitTerms(ANIMAL_GENERIC));
  const microStrongRe = termRegex(splitTerms(MICRO_STRONG).concat([...(tagsLex.micro || [])]));
  const microWeakRe = termRegex(splitTerms(MICRO_WEAK));
  const microTalkRe = termRegex(splitTerms(MICRO_TALK));
  const macroRe = termRegex(splitTerms(MACRO));
  const unRe = {};
  for (const [k, v] of Object.entries(UNWANTED)) unRe[k] = { strong: termRegex(splitTerms(v.strong)), weak: termRegex(splitTerms(v.weak)) };
  // Hashtags: #mantaray / #deepseacreatures — compare against space-less terms.
  const hashTerms = [];
  for (const g of Object.keys(subjTerms)) for (const t of subjTerms[g]) { const c = t.replace(/[\s-]+/g, ''); if (c.length >= 4) hashTerms.push([c, g]); }
  for (const t of splitTerms(MICRO_STRONG)) { const c = t.replace(/[\s-]+/g, ''); if (c.length >= 5) hashTerms.push([c, '@micro']); }
  for (const t of splitTerms(MACRO)) { const c = t.replace(/[\s-]+/g, ''); if (c.length >= 5) hashTerms.push([c, '@macro']); }

  // Pass 1: parse captions, collect Latin-binomial candidates.
  const LATIN_END = /(us|a|um|is|i|ae|es|ii|ensis|oides|ata|atus|ella|ula|ica|icus|ina|inus|osa|osus|ops|ax|ex|ix|yx|on|as|or|ea|ia|ium|ides)$/;
  const parsed = rows.map(r => {
    const cap = captionOf(r);
    const body = cap.replace(/https?:\/\/\S+/g, ' ').replace(/@[\w.]+/g, ' ');   // no URLs, no @handles
    const cands = new Set();
    for (const m of body.matchAll(/\b([A-Z][a-z]{2,})\s+([a-z]{4,})\b/g)) {
      const [, gen, sp] = m;
      if (common.has(sp) || !LATIN_END.test(sp)) continue;
      if (common.has(gen.toLowerCase()) && !LATIN_END.test(gen.toLowerCase())) continue;
      cands.add(gen + ' ' + sp);
    }
    for (const m of body.matchAll(/\b([A-Z][a-z]{3,})\s+spp?\.?(?=\s|$|[,;)])/g)) if (!common.has(m[1].toLowerCase())) cands.add(m[1]);
    return { r, cap, body, cands };
  });
  const allCands = [...new Set(parsed.flatMap(p => [...p.cands]))];
  const taxa = loadJson(TAXA, {});
  const lk = await resolveNames(allCands, taxa);
  if (lk.asked) writeJsonAtomic(TAXA, taxa, true);
  console.log(`Latin-name candidates: ${allCands.length} · new lookups ${lk.asked}${NO_LOOKUP ? ' (skipped: --no-lookup)' : ` → WoRMS ${lk.worms}, GBIF ${lk.gbif}`}`);

  // Pass 2: score.
  const out = loadJson(OUT, { _meta: {}, rows: {} });
  const review = [];
  const hitList = (re, text) => { const s = new Set(); for (const m of text.matchAll(re)) s.add(m[1]); return [...s]; };
  let keptHuman = 0, labelAgree = 0;
  const labels = loadJson(LABELS, {});
  const clipRows = (loadJson(CLIPF, { rows: {} }).rows) || {};
  const BIO_TAG = { fish: 'fish', seaslug: 'seaslug', cephalopod: 'marine-not-fish', gelatinous: 'marine-not-fish', 'coral-anemone': 'marine-not-fish',
    crustacean: 'marine-not-fish', echinoderm: 'marine-not-fish', worm: 'marine-not-fish', sponge: 'marine-not-fish', 'mollusc-other': 'marine-not-fish',
    tunicate: 'marine-not-fish', 'marine-mammal': 'marine-not-fish', 'sea-turtle': 'marine-not-fish', protist: 'marine-not-fish', bird: 'bird',
    'insect-spider': 'other-animal', 'land-vertebrate': 'other-animal', fungi: 'mushroom', plant: 'plant', algae: 'algae' };
  for (const { r, cap, body, cands } of parsed) {
    // Phrases whose words mean something else here: locations, the tree of life.
    const text = norm(body).replace(/x-ray/g, 'xray').replace(/\bof course\b/g, ' ')
      .replace(/\b(off|along) the (coast|coastline|shore)s?( of)?\b/g, ' ').replace(/\bcoast of\b/g, ' ')
      .replace(/\b(tree of life|family tree|phylogenetic tree|evolutionary tree)\b/g, ' ');
    const tags = new Set(), why = {};
    const add = (k, terms) => { if (terms.length) why[k] = [...new Set((why[k] || []).concat(terms))]; };

    // media
    const files = (r.localFiles || []).map(String);
    const isVid = f => /\.(mp4|webm|mov|mkv|m4v)$/i.test(f);
    if (files.some(isVid) || r.durSecs > 0) tags.add('video');
    if (files.some(f => !isVid(f)) || (!files.length && !(r.durSecs > 0))) tags.add('photo');
    if ((r.nItems || 0) > 1 || files.length > 1) tags.add('carousel');

    // subjects
    const subj = {};
    // A hit inside a longer hit of ANOTHER group loses: "sea slug" is not a slug, "whale shark" not a whale.
    const spans = [];
    for (const g of Object.keys(subjRe)) for (const m of text.matchAll(subjRe[g])) spans.push({ g, t: m[1], a: m.index, b: m.index + m[0].length });
    const weakSpans = [];
    for (const x of spans) {
      if (spans.some(y => y.g !== x.g && y.a <= x.a && y.b >= x.b && (y.b - y.a) > (x.b - x.a))) continue;
      if (WEAK_SUBJ.has(x.t)) { weakSpans.push(x); continue; }      // decided below, after taxa + hashtags
      subj[x.g] = (subj[x.g] || 0) + 2; add(x.g, [x.t]);
    }
    const hashtags = [...text.matchAll(/#([a-z0-9_]+)/g)].map(m => m[1]);
    let microHash = 0, macroHash = 0;
    for (const h of hashtags) for (const [t, g] of hashTerms) {
      if (h !== t && h !== t + 's' && t.length >= 5 && h.includes(t)) {
        if (g === '@micro') microHash++; else if (g === '@macro') macroHash++;
        else { subj[g] = (subj[g] || 0) + 2; add(g, ['#' + h]); }
        break;
      }
    }
    let microTax = 0;
    for (const c of cands) {
      const res = groupOfTaxon(taxa[c]); if (!res) continue;
      if (res.g) { subj[res.g] = (subj[res.g] || 0) + 3; add(res.g, [c + ' (' + taxa[c].src + ')']); }
      if (res.s === 'micro') { microTax++; add('micro', [c]); }
    }
    // Idiom-prone words: only where nothing specific was found, or backing up their own group.
    const specific = new Set(Object.keys(subj));
    for (const x of weakSpans) {
      if (specific.size && !specific.has(x.g)) { add('ignored', [x.t]); continue; }
      subj[x.g] = (subj[x.g] || 0) + 1; add(x.g, ['~' + x.t]);
    }
    const generic = hitList(genericRe, text);
    let subjScore = Object.values(subj).reduce((a, b) => a + b, 0);
    if (generic.length) add('animal', generic);
    if (!subjScore && generic.length) { subj.animal = 1; subjScore = 1; }

    // scale
    const microS = hitList(microStrongRe, text), microW = hitList(microWeakRe, text);
    const microT = hitList(microTalkRe, text);
    add('micro', microS); add('micro', microW.map(x => '~' + x));
    if (microS.length || microW.length) add('micro', microT.map(x => '~' + x));
    const macroH = hitList(macroRe, text);
    // "a 5 mm" / "2cm" — a small size, not a lens focal length ("100mm", "10-17mm").
    const sizes = [...text.matchAll(/(?<![\d.\-])(\d+(?:\.\d+)?)\s?(mm|cm|millimet(?:er|re)s?)\b(?!\s*(?:lens|macro|f\/))/g)]
      .filter(m => (m[2] === 'cm' ? +m[1] * 10 : +m[1]) <= 30).map(m => m[0]);
    add('macromicro', macroH.concat(sizes));
    const isMicro = microS.length > 0 || microTax > 0 || microHash > 0 || microW.length >= 2 || (microW.length >= 1 && microT.length >= 1);
    const isMacro = macroH.length > 0 || sizes.length > 0 || macroHash > 0;
    if (isMicro) tags.add('micro');
    if (isMacro && !isMicro) tags.add('macromicro');
    const scaleSubject = isMicro;               // a micrograph counts as wanted even with no taxon named

    // unwanted
    const un = {};
    for (const [k, re] of Object.entries(unRe)) {
      let strong = hitList(re.strong, text), weak = hitList(re.weak, text);
      if (k === 'people' && subjScore >= 2) weak = weak.filter(w => !/^divers?$/.test(w));   // diver WITH an animal = the animal
      if (k === 'people' && strong.includes('meet')) {   // "Meet the dumbo octopus" is not a person
        const line = (norm(body).match(/(^|\n)\s*meet\b[^\n]{0,90}/) || [''])[0];
        // Non-global copies: .test() on the shared /g regexes would leave lastIndex set, and
        // matchAll starts from lastIndex — every later row would silently miss early words.
        const names = Object.values(subjRe).concat(genericRe).map(re => new RegExp(re.source));
        if (!line || names.some(re => re.test(line))) strong = strong.filter(w => w !== 'meet');
      }
      if (strong.length || weak.length) { un[k] = { s: strong.length, w: weak.length, score: strong.length * 2 + weak.length }; add(k, strong.concat(weak.map(x => '~' + x))); }
    }
    const strongUn = Object.entries(un).filter(([, v]) => v.s > 0).map(([k]) => k);

    // verdict
    let verdict;
    const hasSubject = subjScore > 0 || scaleSubject;
    if (hasSubject && subjScore >= 2 || scaleSubject) verdict = strongUn.filter(k => k !== 'gear').length ? 'mixed' : 'keep';
    else if (hasSubject) verdict = Object.keys(un).length ? 'mixed' : 'keep';           // generic "animal" only
    else {
      const best = Object.entries(un).sort((a, b) => b[1].score - a[1].score)[0];
      verdict = best && (best[1].s > 0 || best[1].w >= 3) ? 'drop' : 'unknown';   // fewer cues → unknown, hints kept in why
    }
    for (const g of Object.keys(subj)) tags.add(g);
    if (verdict !== 'keep') for (const [k, v] of Object.entries(un)) if (v.s > 0 || v.score >= 2) tags.add(k);
    if (verdict === 'unknown') tags.add('unknown');

    // ---- image step (igclip.py) — CLIP says what KIND of picture each frame is, BioCLIP
    // which organism. A caption that names a specific animal outranks BioCLIP (it called
    // a Tomopteris worm a fish); the frames decide between caption and picture on
    // keep/drop when they clearly disagree.
    const c = clipRows[r.id];
    let by = CLASSIFIER;
    if (c && c.clipFrac && c.frames && c.frames.length) {
      by += '+clip';
      const F = k => c.clipFrac[k] || 0, pct = x => Math.round(x * 100) + '%';
      const wantF = F('sea-animal') + F('land-animal') + F('bird') + F('plant') + F('mushroom') + F('microscope');
      const img = { people: F('person') + F('people') + (wantF < 0.2 ? F('diver') : 0), text: F('text'), cartoon: F('cartoon'),
        landscape: F('landscape'), gear: F('gear'), seafloor: F('seafloor') };
      const against = Math.max(img.people, img.text, img.cartoon, img.landscape, img.gear) >= 0.5
        || img.people + img.text + img.cartoon + img.landscape + img.gear >= 0.6;
      const imgWant = wantF >= 0.5, imgNone = wantF < 0.15;
      why.image = ['frames ' + c.frames.length + ': ' + Object.entries(c.clipFrac).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + pct(v)).join(' · ')];
      const was = verdict;
      if (verdict === 'keep' && imgNone && against) verdict = 'mixed';
      else if (verdict === 'mixed') verdict = imgWant ? 'keep' : (imgNone && against ? 'drop' : 'mixed');
      else if (verdict === 'drop' && imgWant) verdict = 'mixed';
      else if (verdict === 'unknown') verdict = imgWant ? 'keep' : (imgNone && against ? 'drop' : 'unknown');
      if (verdict !== was) why.image.push(`verdict ${was} → ${verdict}`);
      // organism from BioCLIP only when the caption named nothing specific
      const capSpecific = Object.keys(subj).some(g => g !== 'animal');
      const b = c.bio || {};
      if (b.top) why.image.push(`bioclip: ${b.top} ${b.p} on ${b.on} frame${b.on === 1 ? '' : 's'}` + (capSpecific ? ' (caption wins)' : ''));
      if (!capSpecific && b.on >= 2 && b.p >= 0.35 && BIO_TAG[b.top] && wantF >= 0.25) { subj[BIO_TAG[b.top]] = 1; delete subj.animal; }
      if (verdict === 'keep' && !Object.keys(subj).length) subj.animal = 1;
      if (verdict !== 'keep') {
        if (img.people >= 0.4) tags.add('people');
        if (img.people >= 0.3 && img.text >= 0.15) tags.add('lecture');
        else if (img.text >= 0.4) tags.add('text');
        for (const k of ['cartoon', 'landscape', 'gear', 'seafloor']) if (img[k] >= 0.4) tags.add(k);
      }
      if (!subj.animal) tags.delete('animal');
      for (const g of Object.keys(subj)) tags.add(g);
      // unwanted tags follow the FINAL verdict: none on a keep, the caption's cues on the rest
      if (verdict === 'keep') for (const k of ['people', 'lecture', 'landscape', 'gear', 'cartoon', 'text', 'seafloor']) tags.delete(k);
      else for (const [k, v] of Object.entries(un)) if (v.s > 0 || v.score >= 2) tags.add(k);
      if (verdict === 'unknown') tags.add('unknown'); else tags.delete('unknown');
    }

    let entry = { tags: [...tags], verdict, by, why, at: new Date().toISOString().slice(0, 19) };
    const lab = labels[r.id];
    if (lab) {   // the user's ✗ correction wins; the machine's answer is kept beside it
      entry = { tags: lab.tags || [], verdict: lab.verdict || verdict, by: 'human', note: lab.note || '', machine: { tags: [...tags], verdict, by }, why, at: lab.at };
      keptHuman++;
      if (lab.verdict === verdict) labelAgree++;
    }
    out.rows[r.id] = entry;
    review.push({ id: r.id, author: r.author, url: r.url, file: files.find(f => !isVid(f)) || files[0] || '', files,
      dur: r.durSecs || 0, durs: c ? c.durs : null,
      frames: c && c.frames ? c.frames.map(f => ({ s: f.src, t: f.t, fi: f.fi, c: f.c, cp: f.cp, b: f.b, bp: f.bp })) : [],
      cap: cap.replace(/\s+/g, ' ').slice(0, 400), ...entry });
  }

  out._meta = { classifier: CLASSIFIER, updated: new Date().toISOString().slice(0, 19), rows: Object.keys(out.rows).length };
  writeJsonAtomic(OUT, out, false);
  writeJsonAtomic(REVIEW, { _meta: { classifier: CLASSIFIER, authors: ALL ? ['(all)'] : AUTHORS, at: out._meta.updated, n: review.length }, rows: review }, false);

  // ---------- report ----------
  const count = (arr, f) => arr.reduce((m, x) => { for (const k of [].concat(f(x))) m[k] = (m[k] || 0) + 1; return m; }, {});
  const fmt = m => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log('verdict: ' + fmt(count(review, x => x.verdict)));
  console.log('tags:    ' + fmt(count(review, x => x.tags)));
  if (keptHuman) console.log(`human labels: ${keptHuman} (machine verdict agreed on ${labelAgree})`);
  console.log(`wrote igclass.json (${out._meta.rows} rows total) + igclass.review.json (${review.length}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error(e); process.exit(1); });
