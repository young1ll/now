variable "docker_host" {
  description = "Docker 데몬 주소"
  type        = string
  default     = "unix:///var/run/docker.sock"
}

variable "image" {
  description = "실행할 앱 이미지 (npm run iac:build 로 빌드)"
  type        = string
  default     = "now:local"
}

variable "name" {
  description = "컨테이너·볼륨·네트워크 이름 접두사"
  type        = string
  default     = "now"
}

variable "port" {
  description = "호스트에 노출할 포트"
  type        = number
  default     = 3000
}

variable "bind_ip" {
  description = "노출 IP. 기본은 로컬호스트 전용 (콘솔에 인증이 없으므로 외부 노출 금지)"
  type        = string
  default     = "127.0.0.1"
}

variable "operator_name" {
  description = "콘솔 운영자 표시 이름"
  type        = string
  default     = "운영자"
}

variable "memory_mb" {
  description = "컨테이너 메모리 한도 (MB)"
  type        = number
  default     = 512
}
