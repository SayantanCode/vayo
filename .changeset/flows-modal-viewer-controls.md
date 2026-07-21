---
"@vayo/ui": patch
---

Fixed: a viewer could type into a Flow's name, reorder/remove steps, and
edit extract-variable rows in the Flows panel, with no way to save any of
it (Save/Delete were already correctly hidden). Those controls are now
hidden for viewers too, matching what the server already enforced.
