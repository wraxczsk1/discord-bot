# Skyhaven Survival redesign research

## Reference findings

The Game UI Database separates survival interfaces into title screens, loading screens, HUDs, maps, inventories, settings, tutorials, loot selection, and world maps. It also categorizes useful visual language such as glowing edges, hand-painted textures, teal/cool palettes, tile menus, tabs, tooltips, fade transitions, parallax and VFX.

The open-source Godot Survival-Game reference demonstrates a useful vertical slice: main menu, game-over screen, keyboard layout, pickup-to-inventory flow, animated campfire, day/night cycle, health/hunger/thirst, enemy and animal spawners, NPC house, quests, chest inventory, crafting plans, save/load plans and settings. Its structure suggests separating gameplay, inventory, dialogue, scenes, shaders, sounds and UI instead of keeping everything in one file.

## Redesign decisions

Skyhaven will use a cool teal/night palette with warm amber highlights, layered panels, readable tabs and tooltips, a compact HUD during gameplay, and full-screen menu states for inventory, map, settings and lore. The game loop will include loading progress, main menu, exploration, resource gathering, construction, day/night ambience, creature encounters, inventory slots and a quest/lore panel. The native engine will be separated into renderer, world, entities, UI, input and game-state modules.

Sources: https://www.gameuidatabase.com/index.php?scrn=71 ; https://github.com/z3dd4-de/Survival-Game
