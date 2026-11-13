/**
 * The one-line stories that open the day on X. Each is the caption of one of the site's own videos, as the owner
 * approved it; the same lines turn over beside the desktop quiz (public/js/quiz-facts.js). Add one only from a video
 * that has been approved. `slug` is the supplement page the reply underneath links to ('' for a line with no page).
 */
export interface Hook {
  id: string;
  slug: string;
  text: string;
}

export const HOOKS: Hook[] = [
  { id: 'potassium', slug: 'potassium-131fa', text: 'Trucks of bananas have set off radiation alarms at ports. The reason is potassium, and you are far more radioactive than the bananas.' },
  { id: 'glycine', slug: 'glycine', text: 'Sleep is a temperature problem, and the molecule that cools you was found in a pot of glue in 1820.' },
  { id: 'iodine', slug: 'iodine-8c905', text: 'After Chernobyl, Poland gave 18 million doses of one thing to its children in 3 days. It came from the salt shaker.' },
  { id: 'creatine', slug: 'creatine-ce673', text: 'In 1992, Britain’s Olympic sprinters were quietly using a legal white powder almost nobody in sport had heard of. It was creatine.' },
  { id: 'magnesium', slug: 'magnesium-32aa0', text: 'In 1618 some cows refused to drink from a spring. The bitter salt in it is now in every pharmacy, and at the centre of every green leaf.' },
  { id: 'vitamin-a', slug: 'vitamin-a-43dbf', text: 'Every image you have ever seen began with one molecule snapping straight. Egyptian doctors found it 3,500 years ago.' },
  { id: 'green-tea', slug: 'green-tea-extract-d76c5', text: 'That three o’clock cup is not a pick-me-up. It is a pesticide, and the plant has been drugging bees with it for millions of years.' },
  { id: 'b12', slug: 'vitamin-b12', text: 'A disease that was always fatal, cured in 1926 by half a pound of raw liver a day. Nobody knew why for another 22 years.' },
  { id: 'choline', slug: 'choline-2f904', text: 'Why you forgot why you walked into the room: the molecule that carries memory was found in a dream in 1921.' },
  { id: 'selenium', slug: 'selenium-b2365', text: 'Marco Polo saw a plant that made horses’ hooves fall off. The mineral behind it later saved children’s hearts, and one nut carries the whole story.' },
  { id: 'vitamin-d', slug: 'vitamin-d3-a0118', text: 'The spring sun on your face is making a hormone, not a vitamin, and a Berlin lamp proved it in 1919.' },
  { id: 'hyaluronic', slug: 'hyaluronic-acid', text: 'The gel in your knee came from rooster combs, and racehorses got it forty years before you did.' },
  { id: 'citrulline', slug: 'citrulline-606c9', text: 'The pump in the mirror is a gas with a Nobel Prize, and its best supplier is a watermelon rind.' },
  { id: 'saffron', slug: 'saffron-extracts-814f4', text: 'One kilo of saffron is a hundred and fifty thousand flowers picked at dawn, which is why the price never fell.' },
  { id: 'niacin', slug: 'niacin-vitamin-b3', text: 'A vitamin born from tobacco, renamed so bread would not sound like cigarettes.' },
  { id: 'theanine', slug: 'l-theanine', text: 'A leaf grown in the dark calms an exam hall, and farmers tasted it two centuries before the lab measured it.' },
  { id: 'collagen', slug: 'collagen-c8ddc', text: 'A truck driver drove with the sun on one cheek for 28 years. His face became a medical lesson about the rope that holds skin together.' },
  { id: 'nac', slug: 'n-acetylcysteine-nac', text: 'The painkiller you took this morning is ordinary only because an antidote stands behind it, and that antidote began as a cough syrup.' },
  { id: 'tyrosine', slug: 'l-tyrosine', text: 'The crunch in aged cheese and the brown on a cut apple are the same molecule, and it is what your brain runs on.' },
  { id: 'vitamin-k', slug: 'vitamin-k-8e985', text: 'A Japanese breakfast half the country refuses may be deciding where the nation’s calcium goes.' },
  { id: 'vitamin-e', slug: 'vitamin-e-f4fa7', text: 'A seed can lie in cold soil for years without its oil going off. The reason is the same molecule guarding every cell in your body.' },
  { id: 'ginger', slug: 'ginger-da075', text: 'That sting from a slice of ginger is the last link in a chain of human hands five thousand years long.' },
  { id: 'folate', slug: 'folic-acid-7f343', text: 'In 1931 a jar of yeast spread cured a disease in Bombay before anyone knew what was in it.' },
  { id: 'steps', slug: '', text: 'The 10,000 steps goal came from a Japanese product name, not from a lab.' },
];

/** Days before a line may go out again once every line has had its turn. */
export const HOOK_REPEAT_DAYS = 90;
