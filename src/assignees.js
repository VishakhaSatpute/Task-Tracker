// A project's assignees. Older projects store a single `assignedTo` name; newer ones store `assignees`.
export function getAssignees(project) {
  if (!project) return [];
  if (Array.isArray(project.assignees)) return project.assignees;
  return project.assignedTo ? [project.assignedTo] : [];
}
