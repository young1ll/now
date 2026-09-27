# Now 사업 운영 체제 — 로컬 Docker 배포.
# 데이터(SQLite)는 이름 있는 볼륨에 두어 컨테이너 교체와 무관하게 유지된다.

provider "docker" {
  host = var.docker_host
}

# 이미지는 IaC 밖에서 빌드하고(npm run iac:build), 여기서는 digest 로 고정한다.
# 이미지를 다시 빌드하면 id 가 바뀌어 plan 에 컨테이너 교체가 드러난다.
data "docker_image" "app" {
  name = var.image
}

resource "docker_network" "app" {
  name = "${var.name}-net"
}

resource "docker_volume" "data" {
  name = "${var.name}-data"

  labels {
    label = "managed-by"
    value = "opentofu"
  }

  lifecycle {
    prevent_destroy = true # 사업 데이터 — 실수로 destroy 하지 않도록
  }
}

resource "docker_container" "app" {
  name     = var.name
  image    = data.docker_image.app.id
  restart  = "unless-stopped"
  must_run = true
  memory   = var.memory_mb
  # 명시하지 않으면 Docker 가 memory×2 로 채워 plan 에 영구 드리프트가 생긴다
  memory_swap = var.memory_mb
  init        = true

  env = [
    "NODE_ENV=production",
    "NOW_DB_PATH=/app/data/now.db",
    "NOW_OPERATOR_NAME=${var.operator_name}",
  ]

  ports {
    internal = 3000
    external = var.port
    ip       = var.bind_ip
  }

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/app/data"
  }

  networks_advanced {
    name = docker_network.app.id
  }

  healthcheck {
    test         = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    interval     = "30s"
    timeout      = "5s"
    retries      = 3
    start_period = "10s"
  }

  labels {
    label = "managed-by"
    value = "opentofu"
  }
  labels {
    label = "app"
    value = "now"
  }
}
