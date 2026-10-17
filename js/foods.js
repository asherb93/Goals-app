// Built-in foods (per 100 g, raw/dry unless the name says otherwise) and the Open Food Facts lookup.
// Values are typical averages (USDA-style); people can edit them by adding their own version.
//   Foods.BUILTIN -> [{ id, name, aisle, kcal, protein, carbs, fat, piece?: grams, pieceName? }]
//   Foods.searchOpenFoodFacts(query) -> Promise<[{ code, name, brand, kcal, protein, carbs, fat }]>
(function () {
  const AISLES = ['Meat & fish', 'Dairy & eggs', 'Grains & bread', 'Legumes & tofu', 'Vegetables', 'Fruit', 'Pantry', 'Frozen', 'Other'];

  // [name, aisle, kcal, protein, carbs, fat, pieceGrams?, pieceName?]
  const ROWS = [
    ['Chicken breast (raw)', 'Meat & fish', 120, 22.5, 0, 2.6],
    ['Chicken thigh, boneless (raw)', 'Meat & fish', 177, 18.6, 0, 11],
    ['Turkey breast (raw)', 'Meat & fish', 114, 23.7, 0, 1.5],
    ['Ground beef 15% (raw)', 'Meat & fish', 215, 18.6, 0, 15],
    ['Beef sirloin steak (raw)', 'Meat & fish', 150, 22, 0, 6.5],
    ['Salmon (raw)', 'Meat & fish', 208, 20, 0, 13],
    ['Tuna, canned in water (drained)', 'Meat & fish', 116, 25.5, 0, 0.8, 112, 'can'],
    ['Tilapia (raw)', 'Meat & fish', 96, 20, 0, 1.7],
    ['Shrimp (raw)', 'Meat & fish', 85, 20, 0, 0.5],
    ['Eggs', 'Dairy & eggs', 143, 12.6, 0.7, 9.5, 50, 'egg'],
    ['Egg whites', 'Dairy & eggs', 52, 10.9, 0.7, 0.2],
    ['Cottage cheese 5%', 'Dairy & eggs', 95, 11, 2, 5],
    ['Greek yogurt 0%', 'Dairy & eggs', 59, 10.3, 3.6, 0.4],
    ['Plain yogurt 3%', 'Dairy & eggs', 61, 3.5, 4.7, 3.3],
    ['Milk 3%', 'Dairy & eggs', 60, 3.2, 4.7, 3],
    ['Milk 1%', 'Dairy & eggs', 42, 3.4, 5, 1],
    ['White cheese 5%', 'Dairy & eggs', 95, 10, 3, 5],
    ['Yellow cheese 28%', 'Dairy & eggs', 350, 25, 0, 28],
    ['Feta cheese', 'Dairy & eggs', 264, 14, 4, 21],
    ['Mozzarella', 'Dairy & eggs', 280, 28, 3, 17],
    ['Butter', 'Dairy & eggs', 717, 0.9, 0.1, 81],
    ['Whey protein powder', 'Pantry', 400, 80, 8, 6, 30, 'scoop'],
    ['White rice (dry)', 'Grains & bread', 360, 6.6, 79, 0.6],
    ['Brown rice (dry)', 'Grains & bread', 367, 7.5, 76, 2.7],
    ['Basmati rice (dry)', 'Grains & bread', 356, 8, 78, 0.6],
    ['Pasta (dry)', 'Grains & bread', 371, 13, 75, 1.5],
    ['Whole wheat pasta (dry)', 'Grains & bread', 350, 14, 70, 2.5],
    ['Oats', 'Grains & bread', 389, 16.9, 66, 6.9],
    ['Quinoa (dry)', 'Grains & bread', 368, 14, 64, 6],
    ['Bulgur (dry)', 'Grains & bread', 342, 12, 76, 1.3],
    ['Couscous (dry)', 'Grains & bread', 376, 12.8, 77, 0.6],
    ['Whole wheat bread', 'Grains & bread', 247, 13, 41, 3.4, 30, 'slice'],
    ['White bread', 'Grains & bread', 265, 9, 49, 3.2, 30, 'slice'],
    ['Pita', 'Grains & bread', 275, 9, 56, 1.2, 60, 'pita'],
    ['Tortilla wrap', 'Grains & bread', 310, 8, 52, 8, 60, 'wrap'],
    ['Rice cakes', 'Grains & bread', 387, 8, 81, 2.8, 9, 'cake'],
    ['Potatoes (raw)', 'Vegetables', 77, 2, 17, 0.1],
    ['Sweet potato (raw)', 'Vegetables', 86, 1.6, 20, 0.1],
    ['Chickpeas, canned (drained)', 'Legumes & tofu', 139, 7, 22.5, 2.6],
    ['Lentils (dry)', 'Legumes & tofu', 352, 24.6, 63, 1.1],
    ['Black beans, canned (drained)', 'Legumes & tofu', 91, 6, 16.5, 0.3],
    ['Tofu, firm', 'Legumes & tofu', 144, 15.6, 2.8, 8.7],
    ['Hummus', 'Legumes & tofu', 166, 7.9, 14.3, 9.6],
    ['Tahini', 'Pantry', 595, 17, 21, 54],
    ['Broccoli', 'Vegetables', 34, 2.8, 7, 0.4],
    ['Cucumber', 'Vegetables', 15, 0.7, 3.6, 0.1],
    ['Tomato', 'Vegetables', 18, 0.9, 3.9, 0.2],
    ['Bell pepper', 'Vegetables', 31, 1, 6, 0.3],
    ['Onion', 'Vegetables', 40, 1.1, 9.3, 0.1],
    ['Carrot', 'Vegetables', 41, 0.9, 9.6, 0.2],
    ['Spinach', 'Vegetables', 23, 2.9, 3.6, 0.4],
    ['Lettuce', 'Vegetables', 15, 1.4, 2.9, 0.2],
    ['Zucchini', 'Vegetables', 17, 1.2, 3.1, 0.3],
    ['Mushrooms', 'Vegetables', 22, 3.1, 3.3, 0.3],
    ['Cauliflower', 'Vegetables', 25, 1.9, 5, 0.3],
    ['Green beans', 'Vegetables', 31, 1.8, 7, 0.2],
    ['Eggplant', 'Vegetables', 25, 1, 6, 0.2],
    ['Garlic', 'Vegetables', 149, 6.4, 33, 0.5],
    ['Avocado', 'Fruit', 160, 2, 8.5, 14.7, 150, 'avocado'],
    ['Banana', 'Fruit', 89, 1.1, 22.8, 0.3, 120, 'banana'],
    ['Apple', 'Fruit', 52, 0.3, 13.8, 0.2, 180, 'apple'],
    ['Orange', 'Fruit', 47, 0.9, 11.8, 0.1, 150, 'orange'],
    ['Strawberries', 'Fruit', 32, 0.7, 7.7, 0.3],
    ['Blueberries', 'Fruit', 57, 0.7, 14.5, 0.3],
    ['Medjool dates', 'Fruit', 277, 1.8, 75, 0.2, 24, 'date'],
    ['Lemon', 'Fruit', 29, 1.1, 9.3, 0.3, 80, 'lemon'],
    ['Olive oil', 'Pantry', 884, 0, 0, 100],
    ['Canola oil', 'Pantry', 884, 0, 0, 100],
    ['Peanut butter', 'Pantry', 588, 25, 20, 50],
    ['Almonds', 'Pantry', 579, 21, 22, 50],
    ['Walnuts', 'Pantry', 654, 15, 14, 65],
    ['Honey', 'Pantry', 304, 0.3, 82, 0],
    ['Sugar', 'Pantry', 387, 0, 100, 0],
    ['Soy sauce', 'Pantry', 53, 8, 4.9, 0.6],
    ['Tomato passata', 'Pantry', 29, 1.3, 5.5, 0.2],
    ['Dark chocolate 70%', 'Pantry', 598, 7.8, 46, 43],
    ['Granola', 'Pantry', 471, 10, 64, 20],
    ['Frozen mixed vegetables', 'Frozen', 64, 3.3, 13, 0.5],
    ['Frozen peas', 'Frozen', 81, 5.4, 14, 0.4],
  ];

  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const BUILTIN = ROWS.map(([name, aisle, kcal, protein, carbs, fat, piece, pieceName]) => ({
    id: 'b:' + slug(name), name, aisle, kcal, protein, carbs, fat, builtin: true,
    ...(piece ? { piece, pieceName } : {}),
  }));

  // Open Food Facts: free and open, no key. Best for packaged products (brands, supermarket items).
  async function searchOpenFoodFacts(query) {
    const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&json=1&page_size=12'
      + '&fields=code,product_name,brands,nutriments&search_terms=' + encodeURIComponent(query);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error("Couldn't reach Open Food Facts. Check your internet connection.");
    }
    if (!res.ok) throw new Error(`Open Food Facts answered ${res.status}. Try again in a minute.`);
    const body = await res.json();
    const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
    return (body.products || []).map((p) => {
      const x = p.nutriments || {};
      const kcal = n(x['energy-kcal_100g']) ?? (n(x.energy_100g) != null ? Math.round(n(x.energy_100g) / 4.184) : null);
      return {
        code: String(p.code || ''), name: String(p.product_name || '').trim(), brand: String(p.brands || '').split(',')[0].trim(),
        kcal, protein: n(x.proteins_100g), carbs: n(x.carbohydrates_100g), fat: n(x.fat_100g),
      };
    }).filter((p) => p.name && p.kcal != null);
  }

  window.Foods = { BUILTIN, AISLES, searchOpenFoodFacts };
})();
