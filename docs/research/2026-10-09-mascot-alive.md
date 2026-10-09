# The mascot comes alive: prior art

What the new-chat mascot (a 15×8 dot screen with two eyes, and three crew cursors around it) took from robots,
pixel displays and steering research. Searched 2026-10-09.

## Eyes on small screens

**Anki Cozmo and Vector.** Cozmo's eyes were the first design problem Anki took on. Pupils made him feel too human,
so the animators said where he looks by changing the eyes' size and ratio instead
([Core77](https://www.core77.com/posts/54328/Whats-the-One-Design-Element-That-Can-Make-a-Robot-Lovable)). Vector's
eyes never sit still: they blink, narrow when he thinks, widen when he looks at you and go to slits when he sleeps.
His roughly 1,000 animations are authored in a rigged Maya file, and an engine picks one to fit the moment
([Design News](https://www.designnews.com/testing-measurement/from-cozmo-to-vector-how-anki-designs-robots-with-emotional-intelligence),
[vector-animations-build](https://github.com/digital-dream-labs/vector-animations-build)).
*Taken:* no pupils. Gaze is the whole eye shifting by a cell, and mood is the eye's shape: lids, squash and stretch.
Animations are authored clips, and the Hero picks which one to play.

**Living.ai EMO.** Reviewers single out the expressions that don't mirror: a cheeky wink, a pout when interrupted,
drooping eyes when sad, heart eyes when petted, and a fake cold with sneezes
([Keyi Robot](https://keyirobot.com/en-us/blogs/buying-guide/inside-emo-robots-expressive-design-and-how-it-connects-with-you)).
*Taken:* each eye can have its own shape, lids and look (wink, side-eye, cross-eyed, a "?" over one eye). Also the
sneeze, the drooping "bored" lids, and hearts or stars as reactions.

**Dasai Mochi.** A dashboard companion whose small LCD face reacts to how you drive
([Hackster](https://www.hackster.io/news/build-a-diy-dasai-mochi-with-an-animated-lego-minifig-lcd-face-d25ebdc4af5c)).
I found no write-up of its animation format, so I took only the idea: a desk or dash character earns its keep with
short reactions to events (a finished run, a failure), not a constant show.

**FluxGarage RoboEyes and MD_RobotEyes (Arduino).** Both are open-source eye libraries for tiny displays. RoboEyes
describes an eye by width, height, corner radius and spacing, plus `open`/`close` per eye. Its *confused* animation
shakes the eyes side to side, and an auto-blinker and idle mode reposition the eyes at random intervals
([RoboEyes](https://github.com/FluxGarage/RoboEyes)). MD_RobotEyes plays emotions as a sequence of bitmaps defined
like a font, each held for a pause in ms, stepped by a non-blocking `runAnimation()`
([example](https://wokwi.com/projects/393875395319432193)). *Taken:* the clip format. A clip is a list of frames,
each a tweak to the eye parameters or a set of cells, each with a duration, played by timers. The player never
blocks and never renders more often than the frames change.

## Pixel displays

**Tidbyt / Pixlet and LaMetric.** Pixlet renders an `Animation` as a list of child frames shown at the root's
`delay` in ms ([pixlet](https://github.com/tidbyt/pixlet)). LaMetric animations are pushed as frames, each with its
own duration ([Homey community app](https://community.homey.app/t/36868)). Tidbyt users found the devices reject
long animations, so apps stay short and loop ([Tidbyt forum](https://discuss.tidbyt.com/t/animating-with-sprites/978)).
*Taken:* each frame has its own duration, and long shows (Game of Life, the equaliser) are generators that make the
next frame when it is due, so they never hold a long frame list. A show takes the whole matrix (boot scanline,
confetti, Pac-Man) or adds dots over the eyes (ripple, tears, sweat, fire, z's), always inside the 15×8 cells.

## Steering for the crew cursors

**Craig Reynolds, "Steering Behaviors For Autonomous Characters" (GDC 1999)**
([paper](https://www.red3d.com/cwr/steer/gdc99/)). A vehicle is a point mass. Each step the steering force is
truncated to `max_force`, added to the velocity, and the velocity is truncated to `max_speed`.
- *Seek / flee:* desired velocity toward (or away from) the target at full speed, minus the current velocity.
- *Arrival:* seek, but inside a slowing radius the desired speed ramps down with distance, so it stops on the spot.
- *Wander:* the steering direction is kept on a circle ahead of the vehicle and nudged by a small random amount
  each step, so the path meanders without twitching.
- *Separation:* push away from each neighbour, weighted by inverse distance.
- *Obstacle avoidance:* look ahead along the velocity, and if that runs into an obstacle, steer out along its side.
- *Combining:* weighted sums run several behaviours at once. Discrete changes, like grazing to fleeing, are action
  selection, a state switch.

*Taken:* `ui/steering.ts` implements seek, flee, arrive, wander, separation, box avoidance, containment and the
truncating integrator, plus gravity and bounce for when the cursors fall. Each crew cursor runs a small state machine
(Reynolds' action selection): roam, poke, scatter, gather, sneak, frozen, falling, dazed, rising. Inside each state
it sums weighted behaviours. Each cursor gets its own top speed, force, curiosity, nerve and wander jitter, so the
three don't move in lockstep. One change from the paper: the per-frame "desired minus current velocity" becomes a
force times a gain, so behaviour doesn't depend on the frame rate.
