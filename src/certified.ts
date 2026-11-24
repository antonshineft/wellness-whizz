/** Picks found on an independent certifier's own published list (scripts/certified/certified.json, built by hand-checked matching). Keyed by product link. */
/**
 * The mark of the second, weaker tier: a product that passed a paid consumer testing service's test. Its reports may not
 * be republished, so this line carries no certifier name and no link to a list, and says so in a footnote.
 */
export const PAID_MARK = 'an independent lab';
export const CERTIFIED_ON = '2026-11-23';
export const CERTIFIED: Record<string, { mark: string; source: string; listed: string }> = {
  "https://www.iherb.com/pr/thorne-5-hydroxytryptophan-90-capsules/18506": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne 5-HTP"
  },
  "https://www.iherb.com/pr/thorne-alpha-lipoic-acid-60-capsules-300-mg-per-capsule/18734": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Alpha-Lipoic Acid"
  },
  "https://www.iherb.com/pr/thorne-boswellia-phytosome-60-capsules-350-mg-per-capsule/70004": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Boswellia Phytosome"
  },
  "https://iherb.co/8kUyHzEo": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Elite Casein (USA)"
  },
  "https://iherb.co/FSeUbmAd": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "ON Gold Standard 100% Casein (USA)"
  },
  "https://www.iherb.com/pr/thorne-glucosamine-chondroitin-90-capsules/18565": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Glucosamine & Chondroitin"
  },
  "https://iherb.co/T9bQRMT2": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Collagen Peptides Powder"
  },
  "https://iherb.co/HPp2HWpd": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Micronized Creatine Powder"
  },
  "https://iherb.co/EDTboeiX": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Nuun Hydration Sport"
  },
  "https://www.iherb.com/pr/dripdrop-electrolyte-drink-mix-watermelon-8-sticks-0-35-oz-10-g-each/157494": {
    "mark": "NSF Certified for Sport",
    "source": "https://www.nsfsport.com/certified-products/listing-detail.php?id=1204217",
    "listed": "DripDrop Watermelon"
  },
  "https://www.iherb.com/pr/thorne-pharmagaba-100-60-capsules-100-mg-per-capsule/18741": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne PharmaGABA-100"
  },
  "https://iherb.co/7eJCoQoP": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne L-Glutamine Powder"
  },
  "https://iherb.co/wBxD1s9B": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Trace Minerals"
  },
  "https://iherb.co/T52Kh1Jt": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "MCT Oil Organic C8 C10 C12"
  },
  "https://iherb.co/VYWC2dQN": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Raw Organic Protein"
  },
  "https://iherb.co/qSC22BJU": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Basic Nutrients 2/Day"
  },
  "https://iherb.co/aF2vWvxU": {
    "mark": "IFOS",
    "source": "https://certifications.nutrasource.ca/certified-products/product?id=SPRT0002",
    "listed": "Omega-3 Fish Oil AlaskOmega 1250 mg"
  },
  "https://iherb.co/scAxYMHY": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "ON Gold Standard 100% Whey"
  },
  "https://iherb.co/G6qtKVvG": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Basic Prenatal"
  },
  "https://www.iherb.com/pr/dymatize-elite-casein-protein-powder-cookies-cream-4-lbs-1-8-kg/87271": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Elite Casein (USA)"
  },
  "https://iherb.co/2F5Snb5g": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "ISO100 Hydrolyzed Protein Powder (USA)"
  },
  "https://iherb.co/jpK9pvYe": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "Animal Whey"
  },
  "https://www.iherb.com/pr/legion-athletics-whey-whey-protein-powder-french-vanilla-1-8-lbs-816-g/142101": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Legion",
    "listed": "Legion Whey+ Grass-Fed Whey Isolate French Vanilla"
  },
  "https://iherb.co/7zMmwVQy": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Quercetin Phytosome"
  },
  "https://www.iherb.com/pr/thorne-rhodiola-60-capsules-100-mg-per-capsule/18583": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Rhodiola"
  },
  "https://www.iherb.com/pr/thorne-riboflavin-5-phosphate-36-5-mg-60-capsules/18434": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Riboflavin 5' Phosphate"
  },
  "https://iherb.co/JsHTpxDX": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Selenium"
  },
  "https://iherb.co/5uZTNeHd": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Vitamin K"
  },
  "https://iherb.co/o86bnybp": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "ON Gold Standard 100% Whey"
  },
  "https://www.iherb.com/pr/dymatize-iso100-hydrolyzed-100-whey-protein-isolate-gourmet-chocolate-1-43-lb-650-g/114524": {
    "mark": "Informed Choice",
    "source": "https://choice.wetestyoutrust.com/sites/default/files/generated-pdf/file.pdf",
    "listed": "ISO100 Hydrolyzed Protein Powder (USA)"
  },
  "https://iherb.co/TXrtTnUS": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=21st+Century",
    "listed": "21st Century ONE DAILY Women's"
  },
  "https://www.iherb.com/pr/thorne-zinc-picolinate-15-mg-60-capsules/18476": {
    "mark": "NSF Contents Certified",
    "source": "https://info.nsf.org/Certified/Dietary/Listings.asp?CompanyName=Thorne",
    "listed": "Thorne Zinc Picolinate 15 mg"
  }
};
