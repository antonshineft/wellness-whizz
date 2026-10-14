/* Protein calculator for the "How much protein do I need?" guide. Plain JS, no dependencies. */
(function () {
  var GOALS = {
    muscle: { lo: 1.6, hi: 2.2, label: 'building muscle', note: 'Meta-analyses of resistance-training studies find gains in lean mass plateau at about 1.6 g per kilogram a day; the range up to 2.2 g covers heavy training weeks and the spread between individuals.' },
    fatloss: { lo: 1.8, hi: 2.4, label: 'losing fat while keeping muscle', note: 'In a calorie deficit, higher protein protects muscle and keeps you fuller. The leaner you already are and the deeper the deficit, the closer to the top of the range you should sit.' },
    maintain: { lo: 1.2, hi: 1.6, label: 'staying healthy and moderately active', note: 'The RDA of 0.8 g per kilogram prevents deficiency; 1.2 to 1.6 g is where studies on active adults see better body composition, strength and appetite control.' },
    endurance: { lo: 1.4, hi: 1.8, label: 'endurance training', note: 'Runners, cyclists and swimmers need more than sedentary adults to repair muscle and to spare it during long sessions, especially when carbohydrate intake is low.' },
    older: { lo: 1.2, hi: 1.6, label: 'adults over 65', note: 'Older muscle responds less to each meal. Expert groups put the floor at 1.0 to 1.2 g per kilogram a day and 1.2 to 1.5 g when ill or training, with 25 to 40 g of protein at each meal rather than one large dinner.' },
    sedentary: { lo: 0.8, hi: 1.2, label: 'a mostly sedentary lifestyle', note: '0.8 g per kilogram is the minimum that prevents deficiency in healthy adults, not an optimum. 1.0 to 1.2 g is a better everyday target and costs nothing in side effects.' }
  };
  var FOODS = [
    ['100 g chicken breast, cooked', 31], ['150 g firm tofu', 18], ['1 scoop (30 g) whey protein', 24], ['170 g Greek yogurt', 17],
    ['2 large eggs', 13], ['100 g canned tuna', 25], ['1 cup cooked lentils', 18], ['250 ml milk', 8]
  ];
  function round5(n) { return Math.round(n / 5) * 5; }
  function init(root) {
    var weight = root.querySelector('input[name="weight"]');
    var unit = root.querySelector('select[name="unit"]');
    var goal = root.querySelector('select[name="goal"]');
    var meals = root.querySelector('select[name="meals"]');
    var out = root.querySelector('[data-result]');
    if (!weight || !unit || !goal || !meals || !out) return;
    function render() {
      var w = parseFloat(weight.value);
      if (!(w > 0)) { out.innerHTML = '<p>Enter your body weight to see your range.</p>'; return; }
      var kg = unit.value === 'lb' ? w * 0.4536 : w;
      var lb = unit.value === 'lb' ? w : w / 0.4536;
      var g = GOALS[goal.value] || GOALS.maintain;
      var lo = round5(kg * g.lo), hi = round5(kg * g.hi);
      var n = parseInt(meals.value, 10) || 4;
      var mealLo = Math.round(lo / n), mealHi = Math.round(hi / n);
      var perMeal = Math.round(kg * 0.4);
      var mealLine = 'Over ' + n + ' meals that is ' + mealLo + ' to ' + mealHi + ' g per meal. ';
      if (mealLo < 20) mealLine += 'Below about 20 g a meal, muscle protein synthesis barely responds, so fewer, larger servings work better. ';
      else mealLine += 'That sits near the 0.4 g per kilogram per meal (about ' + perMeal + ' g for you) at which the muscle-building response per meal levels off. ';
      var examples = FOODS.map(function (f) { return f[0] + ' (' + f[1] + ' g)'; }).slice(0, 6).join(', ');
      out.innerHTML =
        '<p class="ww-calc-headline">For ' + Math.round(kg) + ' kg (' + Math.round(lb) + ' lb) and ' + g.label + ': <strong>' + lo + ' to ' + hi + ' g of protein a day</strong>.</p>' +
        '<p>' + mealLine + 'There is no absorption cap: protein above that per-meal amount is still digested and used, it just adds less to muscle for that particular meal.</p>' +
        '<p class="ww-calc-note">' + g.note + '</p>' +
        '<p class="ww-calc-foods">What ' + mealHi + ' g looks like, in food: ' + examples + '.</p>';
    }
    [weight, unit, goal, meals].forEach(function (el) { el.addEventListener('input', render); el.addEventListener('change', render); });
    render();
  }
  function ready() { Array.prototype.forEach.call(document.querySelectorAll('[data-protein-calc]'), init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
