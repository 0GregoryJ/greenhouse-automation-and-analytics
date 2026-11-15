
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select weight
from GREENHOUSE_ANALYTICS.GREENHOUSE_DBT.environmental_score_rules
where weight is null



  
  
      
    ) dbt_internal_test