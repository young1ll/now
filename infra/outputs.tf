output "url" {
  description = "콘솔 주소"
  value       = "http://${var.bind_ip}:${var.port}"
}

output "mcp_url" {
  description = "에이전트 MCP 엔드포인트"
  value       = "http://${var.bind_ip}:${var.port}/api/mcp"
}

output "container" {
  value = docker_container.app.name
}

output "image_id" {
  value = data.docker_image.app.id
}

output "data_volume" {
  value = docker_volume.data.name
}
