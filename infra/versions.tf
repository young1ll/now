terraform {
  required_version = ">= 1.6"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.0"
    }
  }

  # 로컬 단일 운영자 기준: state 는 infra/terraform.tfstate (커밋 금지).
  # 클라우드로 옮길 때 원격 백엔드(S3/GCS/azurerm + 잠금)로 교체한다.
}
