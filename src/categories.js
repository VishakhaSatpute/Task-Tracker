// Two-level task categories: a category (e.g. "Faculty Support") with optional
// sub-items (e.g. professor names). Projects store `categoryId` and `subCategory`;
// older projects have neither and count as uncategorized.

export function categoryLabel(project, categoriesById) {
  const cat = project?.categoryId ? categoriesById?.[project.categoryId] : null;
  if (!cat) return "";
  return project.subCategory ? cat.name + " – " + project.subCategory : cat.name;
}

export function getSubItems(category) {
  return Array.isArray(category?.subItems) ? category.subItems : [];
}
