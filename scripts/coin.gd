extends Area3D
## A spinning coin. Emits `collected` when the player touches it.

signal collected

@export var spin_speed := 2.5
@export var bob_height := 0.15

@onready var mesh: MeshInstance3D = $Mesh

# Random start so the coins don't all bob in sync.
var _time := randf() * TAU
var _picked_up := false


func _ready() -> void:
	body_entered.connect(_on_body_entered)


func _process(delta: float) -> void:
	_time += delta
	rotate_y(spin_speed * delta)
	if not _picked_up:
		mesh.position.y = sin(_time * 2.0) * bob_height


func _on_body_entered(body: Node3D) -> void:
	if _picked_up or not body.is_in_group("player"):
		return
	_picked_up = true
	set_deferred("monitoring", false)
	collected.emit()

	# Little "pop" animation, then remove the coin.
	spin_speed *= 4.0
	var tween := create_tween().set_parallel()
	tween.tween_property(mesh, "position:y", mesh.position.y + 1.0, 0.3)
	tween.tween_property(mesh, "scale", Vector3.ONE * 0.01, 0.3)
	tween.chain().tween_callback(queue_free)
