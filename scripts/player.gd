extends CharacterBody3D
## Third-person player: run, jump, and look around.
## Works with the on-screen touch controls, a keyboard, or a game controller.

@export var speed := 7.0
@export var acceleration := 40.0
@export var jump_velocity := 9.0
## Multiplies the project's gravity. Higher = snappier, less floaty jumps.
@export var gravity_scale := 2.0
@export var look_sensitivity := 0.005
## Falling below this height sends the player back to the start.
@export var fall_limit := -15.0

@onready var model: Node3D = $Model
@onready var camera_pivot: Node3D = $CameraPivot
@onready var spring_arm: SpringArm3D = $CameraPivot/SpringArm3D

var _spawn_position: Vector3
# Lets you still jump for a moment after running off a ledge.
var _coyote_time := 0.0


func _ready() -> void:
	_spawn_position = global_position
	camera_pivot.rotation.x = -0.35
	# Stop the camera arm from colliding with the player's own body.
	spring_arm.add_excluded_object(get_rid())


## Turns the camera. Called by the touch controls when you drag on the right side.
func look(relative: Vector2) -> void:
	camera_pivot.rotation.y -= relative.x * look_sensitivity
	camera_pivot.rotation.x = clampf(camera_pivot.rotation.x - relative.y * look_sensitivity, -1.2, 0.4)


func _physics_process(delta: float) -> void:
	if is_on_floor():
		_coyote_time = 0.12
	else:
		velocity += get_gravity() * gravity_scale * delta
		_coyote_time -= delta

	if Input.is_action_just_pressed("jump") and _coyote_time > 0.0:
		velocity.y = jump_velocity
		_coyote_time = 0.0

	# Move relative to where the camera is facing.
	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var direction := Vector3(input.x, 0.0, input.y).rotated(Vector3.UP, camera_pivot.rotation.y)
	var horizontal := Vector2(velocity.x, velocity.z).move_toward(
			Vector2(direction.x, direction.z) * speed, acceleration * delta)
	velocity.x = horizontal.x
	velocity.z = horizontal.y
	move_and_slide()

	# Turn the body to face the way we're running.
	if direction.length() > 0.1:
		var facing := atan2(-direction.x, -direction.z)
		model.rotation.y = lerp_angle(model.rotation.y, facing, minf(12.0 * delta, 1.0))

	if global_position.y < fall_limit:
		respawn()


func respawn() -> void:
	global_position = _spawn_position
	velocity = Vector3.ZERO
