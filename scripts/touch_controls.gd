extends Control
## On-screen controls for phones and tablets.
##   Left half of the screen:  virtual joystick (appears under your thumb)
##   Right half of the screen: drag to turn the camera
##   Round button, bottom right: jump
##
## The joystick presses the same input actions as the keyboard
## (move_left, move_right, move_forward, move_back, jump), so the player
## script doesn't care where the input comes from.

signal look(relative: Vector2)

const BASE_COLOR := Color(1, 1, 1, 0.15)
const KNOB_COLOR := Color(1, 1, 1, 0.45)
const JUMP_COLOR := Color(1, 1, 1, 0.25)
const JUMP_PRESSED_COLOR := Color(1, 1, 1, 0.5)

# Each finger on the screen has an index; -1 means "no finger".
var _stick_finger := -1
var _stick_center := Vector2.ZERO
var _stick_offset := Vector2.ZERO
var _look_finger := -1
var _jump_finger := -1


func _ready() -> void:
	resized.connect(queue_redraw)


func _exit_tree() -> void:
	# Don't leave the player running if the scene restarts mid-touch.
	_set_stick(Vector2.ZERO)
	Input.action_release("jump")


func _input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		var touch := make_input_local(event) as InputEventScreenTouch
		if touch.pressed:
			_on_touch_pressed(touch.index, touch.position)
		else:
			_on_touch_released(touch.index)
	elif event is InputEventScreenDrag:
		var drag := make_input_local(event) as InputEventScreenDrag
		_on_drag(drag.index, drag.position, drag.relative)


func _on_touch_pressed(finger: int, pos: Vector2) -> void:
	if pos.distance_to(_jump_center()) <= _jump_radius() * 1.3:
		_jump_finger = finger
		Input.action_press("jump")
	elif pos.x < size.x * 0.5:
		if _stick_finger == -1:
			_stick_finger = finger
			_stick_center = pos
			_stick_offset = Vector2.ZERO
	elif _look_finger == -1:
		_look_finger = finger
	queue_redraw()


func _on_touch_released(finger: int) -> void:
	if finger == _jump_finger:
		_jump_finger = -1
		Input.action_release("jump")
	elif finger == _stick_finger:
		_stick_finger = -1
		_stick_offset = Vector2.ZERO
		_set_stick(Vector2.ZERO)
	elif finger == _look_finger:
		_look_finger = -1
	queue_redraw()


func _on_drag(finger: int, pos: Vector2, relative: Vector2) -> void:
	if finger == _stick_finger:
		_stick_offset = (pos - _stick_center).limit_length(_stick_radius())
		_set_stick(_stick_offset / _stick_radius())
		queue_redraw()
	elif finger == _look_finger:
		look.emit(relative)


func _set_stick(value: Vector2) -> void:
	_press_axis("move_left", "move_right", value.x)
	_press_axis("move_forward", "move_back", value.y)


func _press_axis(negative: StringName, positive: StringName, value: float) -> void:
	if value < 0.0:
		Input.action_press(negative, -value)
		Input.action_release(positive)
	elif value > 0.0:
		Input.action_press(positive, value)
		Input.action_release(negative)
	else:
		Input.action_release(negative)
		Input.action_release(positive)


# Sizes scale with the screen so the controls feel the same on any device.
func _stick_radius() -> float:
	return minf(size.x, size.y) * 0.14


func _idle_stick_center() -> Vector2:
	var margin := _stick_radius() * 1.6
	return Vector2(margin, size.y - margin)


func _jump_radius() -> float:
	return minf(size.x, size.y) * 0.1


func _jump_center() -> Vector2:
	var margin := _jump_radius() * 1.8
	return size - Vector2(margin, margin)


func _draw() -> void:
	var stick_center := _stick_center if _stick_finger != -1 else _idle_stick_center()
	draw_circle(stick_center, _stick_radius(), BASE_COLOR)
	draw_circle(stick_center + _stick_offset, _stick_radius() * 0.45, KNOB_COLOR)

	var jump_center := _jump_center()
	var jump_color := JUMP_PRESSED_COLOR if _jump_finger != -1 else JUMP_COLOR
	draw_circle(jump_center, _jump_radius(), jump_color)
	# Up arrow on the jump button.
	var r := _jump_radius() * 0.45
	draw_colored_polygon(PackedVector2Array([
		jump_center + Vector2(0, -r),
		jump_center + Vector2(r, r * 0.6),
		jump_center + Vector2(-r, r * 0.6),
	]), Color(1, 1, 1, 0.8))
